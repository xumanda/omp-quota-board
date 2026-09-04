# omp-quota-board

One-row subscription quota status bar for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) — shows **glm / codex / grok / opencode go / google antigravity** usage in a single line, refreshing automatically every turn.

```text
glm 5h 8% (1h27m) wk 36% (2d18h) | codex1 5h 0% (5h00m) wk 55% (2d22h) cr 2735 | codex2 wk 0% (7d) | grok wk 10% (3d22h) | go 5h 3% (1h35m) wk 18% (11h58m) mo 9% (29d1h) | goog 5h 1% (2h41m) wk 4% (5d20h)
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

To pin a version instead of tracking `main`, substitute a [tag](https://github.com/xumanda/omp-quota-board/tags) (e.g. `.../refs/tags/v1.1.1/quota-board.ts`) for the URL above.

Then **restart OMP** — hooks load at session start.

## Prerequisites

Log into any subset of the providers through OMP (the board detects whatever exists in `auth_credentials`):

| Segment | Subscription | OMP credential (`provider` in agent.db) | Fallback env |
|---|---|---|---|
| `glm` | z.ai GLM Coding Plan | `zai` (api key) | `ZAI_API_KEY` / `GLM_API_KEY` |
| `codex` | ChatGPT Plus/Pro (Codex) | `openai-codex` (OAuth) — one segment per logged-in account (`codex`, or `codex1`, `codex2`, …) | — |
| `grok` | xAI SuperGrok | `xai-oauth` (OAuth) | — |
| `go` | OpenCode Go plan | `opencode-go` (api key) | `OPENCODE_API_KEY` |
| `goog` | Google Antigravity (Gemini / Claude / GPT models) | `google-antigravity` (OAuth) | — |

## Reading the bar

| Example | Meaning |
|---|---|
| `glm 5h 8% (1h27m) wk 36% (2d18h)` | GLM rolling 5h window 8% used, resets in 1h27m; weekly window 36%, resets in 2d18h |
| `codex wk 18% (4d12h) cr 3000` | ChatGPT rate-limit window (kind derived per plan — Plus is weekly) 18% used, resets in 4d12h; plus remaining credits |
| `codex1 … wk 55% (2d22h) cr 2735 \| codex2 …` | Multiple ChatGPT accounts logged in: one segment each, numbered by credential age (oldest = 1), email shown in `/quota` |
| `grok wk 10% (3d22h)` | SuperGrok weekly credits 10% used, resets in 3d22h |
| `go 5h 3% (1h35m) wk 18% (11h58m) mo 9% (29d1h)` | OpenCode Go rolling / weekly / monthly windows, each with its reset countdown |
| `goog 5h 1% (2h41m) wk 4% (5d20h)` | Google Antigravity 5h / weekly windows; the bar shows the tighter of its two pools (Gemini vs Claude/GPT), `/quota` lists both |

Every parenthesized duration is that window's reset countdown.

## Optional companion: GLM warn & gate (`extras/zai-quota-guard.ts`)

> **Why GLM only?** This guard predates the board itself: it was originally built as a
> standalone hook for the author's primary model (GLM), and was later demoted to an
> optional extra once the board took over all quota fetching. It stays GLM-only on
> purpose — see "Why there is no codex/grok/go guard" below.

- a warn toast when the 5h window crosses `ZAI_QUOTA_WARN_PCT` (default 75)
- a confirmation gate on subagent fan-out (`task` tool) at `ZAI_QUOTA_GATE_PCT` (default 90) — headless contexts are blocked with an instructive reason
- a `/glm` command with the full report (level, 5h/weekly windows, web-search quota)

Install alongside the board (same directory, it imports `./quota-board.ts`):

```bash
curl -fsSL -o ~/.omp/agent/hooks/pre/zai-quota-guard.ts \
  https://raw.githubusercontent.com/xumanda/omp-quota-board/main/extras/zai-quota-guard.ts
```

`ZAI_QUOTA_GUARD=0` disables it.

### Why there is no codex / grok / go guard

The gate works by intercepting subagent fan-out (`task` tool calls), because fan-out
burns the **default model's** quota — which is GLM in the author's setup. Whether a
fan-out burns codex, grok, or go depends entirely on which provider your OMP model
roles point at; a generic blocker would guess wrong and block work that isn't even
billing that provider. Blocking real work based on a wrong assumption costs more than
running out of quota, so the red light stays GLM-specific.

For the other three providers the board is display-only today: watch the percentages
climb, and when a window actually runs out the provider itself starts rejecting
requests (codex/grok) or downgrades you to free models (OpenCode Go) — OMP surfaces
that as a request error mid-task. There is no early warning for them yet.

A generic yellow-light toast (per-provider warn thresholds, notification only, no
interference) would be safe to add and doesn't require guessing model→provider
routing — PRs welcome, or open an issue if you want it prioritized.

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
| goog | `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` |

OMP owns OAuth token refresh. When a token expires (e.g. xai access tokens are short-lived), the board keeps showing the last known values until OMP rotates the token the next time you actually use that provider. Network access goes through OMP's runtime (`fetch`), so the usual `HTTP(S)_PROXY` environment variables apply.

### Extending

All fetchers and formatters are exported (`fetchGlm`, `fetchCodex`, `fetchGrok`, `fetchOcgo`, `glmText`, …) so a sibling hook can build policy on top — e.g. warn toasts or throttling subagent fan-out when a window crosses a threshold.

## Caveats

These endpoints are **undocumented** (reverse-engineered from the providers' web consoles / community tooling). They can change without notice; the parser will serve stale data and log instead of crashing. Use at your own risk, and don't hammer them — the default 120s TTL is deliberate.

## 中文速览

OMP（Oh My Pi）单行配额状态栏：把 glm / codex / grok / opencode go / google antigravity 五家订阅的用量显示成一排，每轮对话自动刷新；同一服务登录多个账号时按 codex1 / codex2 分段显示。

```bash
mkdir -p ~/.omp/agent/hooks/pre
curl -fsSL -o ~/.omp/agent/hooks/pre/quota-board.ts \
  https://raw.githubusercontent.com/xumanda/omp-quota-board/main/quota-board.ts
```

重启 OMP 生效。凭据全部运行时读取 OMP 自己的 `~/.omp/agent/agent.db`（文件本身不含任何密钥），未登录的服务自动跳过；`/quota` 命令查看完整报告；`QUOTA_BOARD=0` 关闭。

## License

[MIT](LICENSE)
