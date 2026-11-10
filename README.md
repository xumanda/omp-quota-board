# omp-quota-board

Two-row subscription quota status bar for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) — shows **glm / codex / grok / devin / opencode go** usage, refreshing automatically every turn.

```text
会话 3 轮 | codex1 wk 15% (6d14h) | codex2 5h 1% (2h56m) wk 16% (6d14h) cr 516
glm 5h 32% (2h06m) wk 56% (3d20h) | grok wk 19% (5d) | devin day 0% (17h30m) wk 0% (4d17h) | go 5h 0% (4h59m) wk 47% (1d13h) mo 54% (16d3h)
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
| `devin` | Devin (Cognition) plan | `devin` (OAuth) — one segment per logged-in account (`devin`, or `devin1`, `devin2`, …) | — |

## Reading the bar

| Example | Meaning |
|---|---|
| `glm 5h 8% (1h27m) wk 36% (2d18h)` | GLM rolling 5h window 8% used, resets in 1h27m; weekly window 36%, resets in 2d18h |
| `codex wk 18% (4d12h) cr 3000` | ChatGPT rate-limit window (kind derived per plan — Plus is weekly) 18% used, resets in 4d12h; plus remaining credits (`cr` is omitted when the balance is 0) |
| `codex1 … wk 55% (2d22h) cr 2735 \| codex2 …` | Multiple ChatGPT accounts logged in: one segment each, numbered by credential age (newest = 1), email shown in `/quota` |
| `grok wk 10% (3d22h)` | SuperGrok weekly credits 10% used, resets in 3d22h |
| `go 5h 3% (1h35m) wk 18% (11h58m) mo 9% (29d1h)` | OpenCode Go rolling / weekly / monthly windows, each with its reset countdown |
| `devin day 1% (17h30m) wk 0% (4d17h)` | Devin daily / weekly quota windows with reset countdowns; `/quota` adds the plan name and account email |

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

On `session_start` / `turn_start` the hook fetches (in parallel, TTL-cached) the same read-only usage endpoints each provider's own console uses, parses the windows, and splits them across two clean status rows via `ctx.ui.setStatus` (`quota-board-1` and `quota-board-2`) so multi-account pools never truncate on standard terminal widths.

| Provider | Endpoint |
|---|---|
| glm | `GET https://api.z.ai/api/monitor/usage/quota/limit` |
| codex | `GET https://chatgpt.com/backend-api/wham/usage` |
| grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| go | `GET https://opencode.ai/zen/go/v1/usage` |
| devin | `POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus` (Connect RPC, JSON codec) |

OMP owns OAuth token refresh. When a token expires (e.g. xai access tokens are short-lived), the board keeps showing the last known values until OMP rotates the token the next time you actually use that provider. Network access goes through OMP's runtime (`fetch`), so the usual `HTTP(S)_PROXY` environment variables apply.

### Extending

All fetchers and formatters are exported (`fetchGlm`, `fetchCodex`, `fetchGrok`, `fetchOcgo`, `glmText`, …) so a sibling hook can build policy on top — e.g. warn toasts or throttling subagent fan-out when a window crosses a threshold.

## Caveats

These endpoints are **undocumented** (reverse-engineered from the providers' web consoles / community tooling). They can change without notice; the parser will serve stale data and log instead of crashing. Use at your own risk, and don't hammer them — the default 120s TTL is deliberate.

## 中文速览

OMP（Oh My Pi）双行配额状态栏：把 glm / codex / grok / devin / opencode go 五家订阅的用量按两行清爽显示（第一行 Codex，第二行 GLM + Grok + Devin + OpenCode Go），每轮对话自动刷新；同一服务登录多个账号时按 codex1 / codex2、devin1 / devin2 分段显示，彻底解决单行超长在终端被截断的问题。

```bash
mkdir -p ~/.omp/agent/hooks/pre
curl -fsSL -o ~/.omp/agent/hooks/pre/quota-board.ts \
  https://raw.githubusercontent.com/xumanda/omp-quota-board/main/quota-board.ts
```

重启 OMP 生效。凭据全部运行时读取 OMP 自己的 `~/.omp/agent/agent.db`（文件本身不含任何密钥），未登录的服务自动跳过；`/quota` 命令查看完整报告；`QUOTA_BOARD=0` 关闭。

## License

[MIT](LICENSE)
