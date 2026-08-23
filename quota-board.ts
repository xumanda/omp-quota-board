import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * omp-quota-board — one-row quota status bar for Oh My Pi (OMP).
 *
 * Renders a single status key ("quota-board") so the bar stays one row:
 *   glm 5h 4% (reset 1h02m) wk 33% | codex wk 15% (reset 4d17h) cr 3000 |
 *   grok wk 7% (reset 4d3h) | go 5h 33% (reset 1h28m) wk 17% mo 8%
 * Providers without credentials are silently skipped.
 *
 * Quota sources (read-only GETs, same endpoints the providers' own consoles
 * use; several are undocumented and may change without notice):
 *   glm   : GET https://api.z.ai/api/monitor/usage/quota/limit
 *   codex : GET https://chatgpt.com/backend-api/wham/usage
 *           (window kind from limit_window_seconds:
 *            18000=5h, 604800=wk, 2628000=mo)
 *   grok  : GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *   go    : GET https://opencode.ai/zen/go/v1/usage
 *
 * Credentials are read at runtime from OMP's own store
 * (~/.omp/agent/agent.db, auth_credentials, disabled_cause IS NULL, newest
 * first) plus classic env fallbacks — this file stores no secrets:
 *   glm   : env ZAI_API_KEY | GLM_API_KEY, else agent.db 'zai' api_key .key
 *   codex : agent.db 'openai-codex' oauth .access (+ .accountId header)
 *   grok  : agent.db 'xai-oauth' oauth .access
 *   go    : env OPENCODE_API_KEY, else agent.db 'opencode-go' api_key .key
 * OMP owns OAuth refresh; when a token expires this hook serves the last
 * known values until OMP rotates it.
 *
 * Env knobs: QUOTA_BOARD=0 disables; QUOTA_BOARD_TTL_MS tunes the refresh
 * interval (default 120s). Fetch failures serve stale data and log quietly.
 */

const GLM_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const OCGO_URL = "https://opencode.ai/zen/go/v1/usage";

const TTL_MS = (() => {
  const v = Number(process.env.QUOTA_BOARD_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 120_000;
})();
const ENABLED = !/^(0|false|off)$/i.test(process.env.QUOTA_BOARD ?? "1");

interface Win {
  pct?: number;
  resetMs: number;
}

// --- shared helpers --------------------------------------------------------

export function fmtDuration(msDelta: number): string {
  const mins = Math.max(0, Math.round(msDelta / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function fmtLocal(ms: number): string {
  const t = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

function readCredential(
  provider: string,
  credentialType: "oauth" | "api_key",
  field: string,
): string | undefined {
  try {
    const db = new Database(join(homedir(), ".omp", "agent", "agent.db"), {
      readonly: true,
    });
    try {
      db.run("PRAGMA busy_timeout = 2000");
      const rows = db
        .query(
          "SELECT data FROM auth_credentials WHERE provider=? " +
            "AND credential_type=? AND disabled_cause IS NULL " +
            "ORDER BY updated_at DESC",
        )
        .all(provider, credentialType) as Array<{ data: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          const value = parsed[field];
          if (typeof value === "string" && value) return value;
        } catch {
          /* try next row */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

// --- glm (z.ai GLM Coding Plan) --------------------------------------------

export interface GlmState {
  level?: string;
  fiveHour?: Win;
  weekly?: Win;
  searches: Array<Record<string, unknown>>;
  fetchedAt: number;
}

let glmCache: GlmState | undefined;

export async function fetchGlm(
  force: boolean,
  log?: (...args: unknown[]) => void,
): Promise<GlmState | undefined> {
  if (!ENABLED) return undefined;
  if (!force && glmCache && Date.now() - glmCache.fetchedAt < TTL_MS)
    return glmCache;
  const envKey = process.env.ZAI_API_KEY || process.env.GLM_API_KEY;
  const key = envKey || readCredential("zai", "api_key", "key");
  if (!key) {
    log?.("quota-board: no zai api key (env ZAI_API_KEY/GLM_API_KEY or agent.db); glm quota disabled");
    return glmCache;
  }
  try {
    const payload = await fetchJson(GLM_URL, {
      Authorization: `Bearer ${key}`,
    });
    const limits = (payload.data as Record<string, unknown> | undefined)?.limits;
    if (!Array.isArray(limits)) throw new Error("unexpected response shape");
    const tokenWindows: Array<{ resetMs: number; item: Record<string, unknown> }> = [];
    const searches: Array<Record<string, unknown>> = [];
    for (const item of limits as Array<Record<string, unknown>>) {
      const reset = item.nextResetTime;
      if (
        (item.type === "TOKENS_LIMIT" || item.type === "CREDIT_LIMIT") &&
        typeof reset === "number"
      ) {
        tokenWindows.push({ resetMs: reset, item });
      } else if (item.type === "TIME_LIMIT") {
        searches.push(item);
      }
    }
    tokenWindows.sort((a, b) => a.resetMs - b.resetMs);
    const win = (t: { resetMs: number; item: Record<string, unknown> }): Win => ({
      pct: typeof t.item.percentage === "number" ? t.item.percentage : undefined,
      resetMs: t.resetMs,
    });
    glmCache = {
      level: typeof (payload.data as Record<string, unknown>)?.level === "string"
        ? ((payload.data as Record<string, unknown>).level as string)
        : undefined,
      fiveHour: tokenWindows[0] ? win(tokenWindows[0]) : undefined,
      weekly: tokenWindows.length > 1 ? win(tokenWindows[tokenWindows.length - 1]) : undefined,
      searches,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    log?.(`quota-board: glm fetch failed: ${String(err)}`);
  }
  return glmCache; // stale on failure
}

export function glmText(s: GlmState): string | undefined {
  if (!s.fiveHour) return undefined;
  let text = `glm 5h ${s.fiveHour.pct ?? "?"}% (reset ${fmtDuration(s.fiveHour.resetMs - Date.now())})`;
  if (s.weekly?.pct !== undefined) text += ` wk ${s.weekly.pct}%`;
  return text;
}

// --- codex (ChatGPT/OpenAI subscription) -----------------------------------

interface CodexState {
  plan?: string;
  primary?: Win & { label: string };
  secondary?: Win & { label: string };
  creditsBalance?: string;
  fetchedAt: number;
}

let codexCache: CodexState | undefined;

const CODEX_WINDOW_LABELS: Record<number, string> = {
  18000: "5h",
  604800: "wk",
  2628000: "mo",
};

function parseCodexWindow(raw: unknown): (Win & { label: string }) | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  const pct = w.used_percent;
  const secs = w.limit_window_seconds;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return undefined;
  const label = (typeof secs === "number" && CODEX_WINDOW_LABELS[secs]) || "win";
  let resetMs = 0;
  if (typeof w.reset_at === "number" && w.reset_at > 0) resetMs = w.reset_at * 1000;
  else if (typeof w.reset_after_seconds === "number" && w.reset_after_seconds > 0)
    resetMs = Date.now() + w.reset_after_seconds * 1000;
  return { pct: Math.round(pct), resetMs, label };
}

export async function fetchCodex(
  force: boolean,
  log?: (...args: unknown[]) => void,
): Promise<CodexState | undefined> {
  if (!ENABLED) return undefined;
  if (!force && codexCache && Date.now() - codexCache.fetchedAt < TTL_MS)
    return codexCache;
  const token = readCredential("openai-codex", "oauth", "access");
  if (!token) {
    log?.("quota-board: no openai-codex oauth token in agent.db; codex quota disabled");
    return codexCache;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "omp-quota-board",
  };
  const accountId = readCredential("openai-codex", "oauth", "accountId");
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  try {
    const data = await fetchJson(CODEX_URL, headers);
    const rl = data.rate_limit as Record<string, unknown> | null | undefined;
    const credits = data.credits as Record<string, unknown> | null | undefined;
    codexCache = {
      plan: typeof data.plan_type === "string" ? data.plan_type : undefined,
      primary: parseCodexWindow(rl?.primary_window),
      secondary: parseCodexWindow(rl?.secondary_window),
      creditsBalance:
        credits && typeof credits.balance === "string" ? credits.balance : undefined,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    log?.(`quota-board: codex fetch failed: ${String(err)}`);
  }
  return codexCache; // stale on failure
}

export function codexText(s: CodexState): string | undefined {
  const parts: string[] = [];
  const w = s.primary ?? s.secondary;
  if (w) {
    let text = `codex ${w.label} ${w.pct}%`;
    if (w.resetMs > 0) text += ` (reset ${fmtDuration(w.resetMs - Date.now())})`;
    parts.push(text);
  }
  const other = s.primary && s.secondary ? s.secondary : undefined;
  if (other) parts.push(`${other.label} ${other.pct}%`);
  if (parts.length === 0) return undefined;
  if (s.creditsBalance) parts.push(`cr ${s.creditsBalance}`);
  return parts.join(" ");
}

// --- grok (xAI SuperGrok via OMP xai-oauth) --------------------------------

interface GrokState {
  pct: number;
  label: string; // wk / mo / d
  resetMs: number;
  fetchedAt: number;
}

let grokCache: GrokState | undefined;

const GROK_PERIOD_LABELS: Array<[string, string]> = [
  ["WEEK", "wk"],
  ["MONTH", "mo"],
  ["DAY", "d"],
];

export async function fetchGrok(
  force: boolean,
  log?: (...args: unknown[]) => void,
): Promise<GrokState | undefined> {
  if (!ENABLED) return undefined;
  if (!force && grokCache && Date.now() - grokCache.fetchedAt < TTL_MS)
    return grokCache;
  const token = readCredential("xai-oauth", "oauth", "access");
  if (!token) {
    log?.("quota-board: no xai-oauth token in agent.db; grok quota disabled");
    return grokCache;
  }
  try {
    const data = await fetchJson(GROK_URL, {
      Authorization: `Bearer ${token}`,
      "User-Agent": "omp-quota-board",
      "x-grok-client-surface": "grok-build",
      "x-grok-client-version": "1.0.0",
    });
    const config = data.config as Record<string, unknown> | undefined;
    const pct = config?.creditUsagePercent;
    if (typeof pct !== "number" || !Number.isFinite(pct))
      throw new Error("unexpected billing response shape");
    const period = config?.currentPeriod as Record<string, unknown> | undefined;
    const type = typeof period?.type === "string" ? period.type : "";
    const label =
      GROK_PERIOD_LABELS.find(([needle]) => type.includes(needle))?.[1] ?? "p";
    const resetMs = typeof period?.end === "string" ? Date.parse(period.end) : 0;
    grokCache = {
      pct: Math.round(pct),
      label,
      resetMs: Number.isFinite(resetMs) ? resetMs : 0,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    log?.(`quota-board: grok fetch failed: ${String(err)}`);
  }
  return grokCache; // stale on failure
}

export function grokText(s: GrokState): string {
  let text = `grok ${s.label} ${s.pct}%`;
  if (s.resetMs > 0) text += ` (reset ${fmtDuration(s.resetMs - Date.now())})`;
  return text;
}

// --- go (OpenCode Go plan) --------------------------------------------------

interface OcgoState {
  rolling?: Win;
  weeklyPct?: number;
  monthlyPct?: number;
  fetchedAt: number;
}

let ocgoCache: OcgoState | undefined;

function parseOcgoWindow(raw: unknown): Win | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  if (w.status !== "ok") return undefined;
  const pct = w.percent;
  const resetsAt = w.resetsAt;
  if (typeof pct !== "number" || typeof resetsAt !== "string") return undefined;
  const resetMs = Date.parse(resetsAt);
  return { pct: Math.round(pct), resetMs: Number.isFinite(resetMs) ? resetMs : 0 };
}

export async function fetchOcgo(
  force: boolean,
  log?: (...args: unknown[]) => void,
): Promise<OcgoState | undefined> {
  if (!ENABLED) return undefined;
  if (!force && ocgoCache && Date.now() - ocgoCache.fetchedAt < TTL_MS)
    return ocgoCache;
  const key = process.env.OPENCODE_API_KEY || readCredential("opencode-go", "api_key", "key");
  if (!key) {
    log?.("quota-board: no opencode-go api key (env OPENCODE_API_KEY or agent.db); go quota disabled");
    return ocgoCache;
  }
  try {
    const data = await fetchJson(OCGO_URL, {
      Authorization: `Bearer ${key}`,
      "User-Agent": "omp-quota-board",
    });
    const usage = data.usage as Record<string, unknown> | undefined;
    if (!usage) throw new Error("unexpected usage response shape");
    ocgoCache = {
      rolling: parseOcgoWindow(usage.rolling),
      weeklyPct: parseOcgoWindow(usage.weekly)?.pct,
      monthlyPct: parseOcgoWindow(usage.monthly)?.pct,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    log?.(`quota-board: go fetch failed: ${String(err)}`);
  }
  return ocgoCache; // stale on failure
}

export function ocgoText(s: OcgoState): string | undefined {
  if (!s.rolling && s.weeklyPct === undefined && s.monthlyPct === undefined)
    return undefined;
  const parts: string[] = [];
  if (s.rolling) {
    let text = `go 5h ${s.rolling.pct}%`;
    if (s.rolling.resetMs > 0)
      text += ` (reset ${fmtDuration(s.rolling.resetMs - Date.now())})`;
    parts.push(text);
  }
  if (s.weeklyPct !== undefined) parts.push(`wk ${s.weeklyPct}%`);
  if (s.monthlyPct !== undefined) parts.push(`mo ${s.monthlyPct}%`);
  return parts.join(" ");
}

// --- hook wiring -----------------------------------------------------------

export default function quotaBoard(pi: HookAPI): void {
  const log = (...args: unknown[]) => pi.logger?.warn?.(...(args as [string]));

  const refreshStatus = async (ctx: {
    ui?: { setStatus?: (k: string, t: string) => void };
  }) => {
    const [glm, codex, grok, ocgo] = await Promise.all([
      fetchGlm(false, log).then((s) => s && glmText(s)),
      fetchCodex(false, log).then((s) => s && codexText(s)),
      fetchGrok(false, log).then((s) => s && grokText(s)),
      fetchOcgo(false, log).then((s) => s && ocgoText(s)),
    ]);
    const segments = [glm, codex, grok, ocgo].filter(
      (t): t is string => typeof t === "string",
    );
    if (segments.length > 0)
      ctx.ui?.setStatus?.("quota-board", segments.join(" | "));
  };

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  try {
    pi.registerCommand("quota", {
      description: "GLM / Codex / Grok / OpenCode Go quota report",
      handler: async (_args, ctx) => {
        const [glm, codex, grok, ocgo] = await Promise.all([
          fetchGlm(true, log),
          fetchCodex(true, log),
          fetchGrok(true, log),
          fetchOcgo(true, log),
        ]);
        const lines: string[] = ["Quota board (glm / codex / grok / opencode go)"];
        if (glm) {
          const bits: string[] = [];
          if (glm.fiveHour)
            bits.push(
              `5h ${glm.fiveHour.pct ?? "?"}%` +
                (glm.fiveHour.resetMs > 0 ? `, resets ${fmtLocal(glm.fiveHour.resetMs)}` : ""),
            );
          if (glm.weekly?.pct !== undefined)
            bits.push(`wk ${glm.weekly.pct}%`);
          lines.push(`  glm  : ${bits.join(" | ") || "no windows"} (level ${glm.level ?? "?"})`);
        } else {
          lines.push("  glm  : unavailable (no key or fetch failed)");
        }
        if (codex) {
          lines.push(
            `  codex (${codex.plan ?? "?"}): ` +
              (codex.primary
                ? `${codex.primary.label} ${codex.primary.pct}%` +
                  (codex.primary.resetMs > 0
                    ? `, resets ${fmtLocal(codex.primary.resetMs)}`
                    : "")
                : "no window") +
              (codex.secondary
                ? ` | ${codex.secondary.label} ${codex.secondary.pct}%`
                : "") +
              (codex.creditsBalance ? ` | credits ${codex.creditsBalance}` : ""),
          );
        } else {
          lines.push("  codex: unavailable (no token in agent.db or fetch failed)");
        }
        if (grok) {
          lines.push(
            `  grok : ${grok.label} ${grok.pct}%` +
              (grok.resetMs > 0 ? `, resets ${fmtLocal(grok.resetMs)}` : ""),
          );
        } else {
          lines.push("  grok : unavailable (no token in agent.db or fetch failed)");
        }
        if (ocgo) {
          const bits: string[] = [];
          if (ocgo.rolling)
            bits.push(
              `5h ${ocgo.rolling.pct}%` +
                (ocgo.rolling.resetMs > 0
                  ? ` (resets ${fmtLocal(ocgo.rolling.resetMs)})`
                  : ""),
            );
          if (ocgo.weeklyPct !== undefined) bits.push(`wk ${ocgo.weeklyPct}%`);
          if (ocgo.monthlyPct !== undefined) bits.push(`mo ${ocgo.monthlyPct}%`);
          lines.push(`  go   : ${bits.join(" | ") || "no windows"}`);
        } else {
          lines.push("  go   : unavailable (no api key or fetch failed)");
        }
        lines.push(
          `  knobs: ttl=${Math.round(TTL_MS / 1000)}s (QUOTA_BOARD_TTL_MS, QUOTA_BOARD)`,
        );
        ctx.ui?.notify?.(lines.join("\n"));
      },
    });
  } catch (err) {
    log?.(`quota-board: registerCommand('quota') failed: ${String(err)}`);
  }
}
