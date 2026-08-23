# omp-quota-board

One-row subscription quota status bar for [Oh My Pi (OMP)](https://github.com/anthropics/oh-my-pi) — shows **glm / codex / grok / opencode go** usage in a single line, refreshing automatically every turn.

```
glm 5h 8% (1h27m) wk 36% (2d18h) | codex wk 18% (4d12h) cr 3000 | grok wk 10% (3d22h) | go 5h 3% (1h35m) wk 18% (11h58m) mo 9% (29d1h)
```

- **Single file, zero dependencies** — one TypeScript hook; OMP runs it on its bundled Bun runtime (`bun:sqlite` + `fetch`, nothing to install).
- **No secrets stored** — credentials are read at runtime from OMP's own credential store (`~/.omp/agent/agent.db`), so if you can use a provider in OMP, the board can display its quota.
- **Only shows what you have** — providers without credentials are silently skipped.
- **Never breaks your status bar** — fetch failures serve the last known values (stale-serve) and log quietly.
- **`/quota` command** — force-refresh and get a full report with exact reset times.

## Install

Drop the hook into OMP's hook directory and restart OMP:

```bash
mkdir -p ~/.omp/agent/hooks/pre
curl -fsSL -o ~/.omp/agent/hooks/pre/quota-board.ts \
  https://raw.githubusercontent.com/xumanda/omp-quota-board/main/quota-board.ts
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.omp\agent\hooks\pre" | Out-Null
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/xumanda/omp-quota-board/main/quota-board.ts" `
  -OutFile "$env:USERPROFILE\.omp\agent\hooks\pre\quota-board.ts"
```

To pin a version instead of tracking `main`, substitute a [tag](https://github.com/xumanda/omp-quota-board/tags) (e.g. `.../refs/tags/v1.1.0/quota-board.ts`) for the URL above.

Then **restart OMP** — hooks load at session start.

## Prerequisites

Log into any subset of the providers through OMP (the board detects whatever exists in `auth_credentials`):

| Segment | Subscription | OMP credential (`provider` in agent.db) | Fallback env |
|---|---|---|---|
| `glm` | z.ai GLM Coding Plan | `zai` (api key) | `ZAI_API_KEY` / `GLM_API_KEY` |
| `codex` | ChatGPT Plus/Pro (Codex) | `openai-codex` (OAuth) | — |
| `grok` | xAI SuperGrok | `xai-oauth` (OAuth) | — |
| `go` | OpenCode Go plan | `opencode-go` (api key) | `OPENCODE_API_KEY` |

## Reading the bar

| Example | Meaning |
|---|---|
| `glm 5h 8% (1h27m) wk 36% (2d18h)` | GLM rolling 5h window 8% used, resets in 1h27m; weekly window 36%, resets in 2d18h |
| `codex wk 18% (4d12h) cr 3000` | ChatGPT rate-limit window (kind derived per plan — Plus is weekly) 18% used, resets in 4d12h; plus remaining credits |
| `grok wk 10% (3d22h)` | SuperGrok weekly credits 10% used, resets in 3d22h |
| `go 5h 3% (1h35m) wk 18% (11h58m) mo 9% (29d1h)` | OpenCode Go rolling / weekly / monthly windows, each with its reset countdown |

Every parenthesized duration is that window's reset countdown.

## Optional companion: GLM warn & gate (`extras/zai-quota-guard.ts`)

If you use the GLM Coding Plan as your main workhorse, an optional policy hook reuses the board's data layer (shared cache, no extra z.ai requests) to add:

- a warn toast when the 5h window crosses `ZAI_QUOTA_WARN_PCT` (default 75)
- a confirmation gate on subagent fan-out (`task` tool) at `ZAI_QUOTA_GATE_PCT` (default 90) — headless contexts are blocked with an instructive reason
- a `/glm` command with the full report (level, 5h/weekly windows, web-search quota)

Install alongside the board (same directory, it imports `./quota-board.ts`):

```bash
curl -fsSL -o ~/.omp/agent/hooks/pre/zai-quota-guard.ts \
  https://raw.githubusercontent.com/xumanda/omp-quota-board/main/extras/zai-quota-guard.ts
```

`ZAI_QUOTA_GUARD=0` disables it.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `QUOTA_BOARD` | `1` | `0`/`false`/`off` disables the hook |
| `QUOTA_BOARD_TTL_MS` | `120000` | Cache interval; fetches happen at most once per TTL |

## How it works

On `session_start` / `turn_start` the hook fetches (in parallel, TTL-cached) the same read-only usage endpoints each provider's own console uses, parses the windows, and writes **one** status key via `ctx.ui.setStatus` — OMP renders one key per row, so a single joined key is what keeps everything on one line.

| Provider | Endpoint |
|---|---|
| glm | `GET https://api.z.ai/api/monitor/usage/quota/limit` |
| codex | `GET https://chatgpt.com/backend-api/wham/usage` |
| grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| go | `GET https://opencode.ai/zen/go/v1/usage` |

OMP owns OAuth token refresh. When a token expires (e.g. xai access tokens are short-lived), the board keeps showing the last known values until OMP rotates the token the next time you actually use that provider. Network access goes through OMP's runtime (`fetch`), so the usual `HTTP(S)_PROXY` environment variables apply.

### Extending

All fetchers and formatters are exported (`fetchGlm`, `fetchCodex`, `fetchGrok`, `fetchOcgo`, `glmText`, …) so a sibling hook can build policy on top — e.g. warn toasts or throttling subagent fan-out when a window crosses a threshold.

## Caveats

These endpoints are **undocumented** (reverse-engineered from the providers' web consoles / community tooling). They can change without notice; the parser will serve stale data and log instead of crashing. Use at your own risk, and don't hammer them — the default 120s TTL is deliberate.

## 中文速览

OMP（Oh My Pi）单行配额状态栏：把 glm / codex / grok / opencode go 四家订阅的用量显示成一排，每轮对话自动刷新。

```bash
mkdir -p ~/.omp/agent/hooks/pre
curl -fsSL -o ~/.omp/agent/hooks/pre/quota-board.ts \
  https://raw.githubusercontent.com/xumanda/omp-quota-board/main/quota-board.ts
```

重启 OMP 生效。凭据全部运行时读取 OMP 自己的 `~/.omp/agent/agent.db`（文件本身不含任何密钥），未登录的服务自动跳过；`/quota` 命令查看完整报告；`QUOTA_BOARD=0` 关闭。

## License

[MIT](LICENSE)
