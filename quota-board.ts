import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * omp-quota-board — two-row quota status bar for Oh My Pi (OMP).
 *
 * Renders two status keys ("quota-board-1"/"quota-board-2") so long multi-account
 * lines don't truncate on typical terminal widths:
 *   row 1: 会话 3 轮 | codex1 5h 1% (2h56m) wk 16% (6d14h) cr 516 | codex2 wk 15% (6d14h)
 *   row 2: glm 5h 4% (1h02m) wk 33% (26h) | grok wk 7% (4d3h) | goog 5h 0% (4h42m) wk 0% (6d23h) | go 5h 33% (1h28m) wk 17% (5d) mo 8% (12d)
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
 *   goog  : POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 *           (Antigravity; two pools — Gemini Models and Claude/GPT models —
 *            each with weekly and 5h buckets of remainingFraction)
 *
 * Credentials are read at runtime from OMP's own store
 * (~/.omp/agent/agent.db, auth_credentials, disabled_cause IS NULL, newest
 * first) plus classic env fallbacks — this file stores no secrets:
 *   glm   : env ZAI_API_KEY | GLM_API_KEY, else agent.db 'zai' api_key .key
 *   codex : agent.db 'openai-codex' oauth rows (.access + .accountId header) —
 *           every logged-in account gets its own segment: "codex" when there
 *           is one, "codex1", "codex2", … by credential row id (newest first)
 *   grok  : agent.db 'xai-oauth' oauth .access
 *   go    : env OPENCODE_API_KEY, else agent.db 'opencode-go' api_key .key
 *   goog  : agent.db 'google-antigravity' oauth .access (+ .projectId body)
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
const AGY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const AGY_UA =
  "antigravity/hub/2.19.1 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)";

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
  init?: { method?: string; body?: string },
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    body: init?.body,
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
  let text = `glm 5h ${s.fiveHour.pct ?? "?"}%`;
  if (s.fiveHour.resetMs > 0)
    text += ` (${fmtDuration(s.fiveHour.resetMs - Date.now())})`;
  if (s.weekly?.pct !== undefined) {
    text += ` wk ${s.weekly.pct}%`;
    if (s.weekly.resetMs > 0)
      text += ` (${fmtDuration(s.weekly.resetMs - Date.now())})`;
  }
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

export interface CodexAccount {
  key: string; // agent.db credential row id — stable anchor for cache & order
  email?: string;
  state: CodexState;
}

let codexAccounts: CodexAccount[] | undefined;

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

function fmtCredits(balance: string): string {
  const n = Number.parseFloat(balance);
  return Number.isFinite(n) ? String(Math.floor(n)) : balance;
}

interface CodexCred {
  key: string;
  access: string;
  accountId?: string;
  email?: string;
}

/** All logged-in openai-codex oauth rows, newest credential first. */
function readCodexCreds(): CodexCred[] {
  const creds: CodexCred[] = [];
  try {
    const db = new Database(join(homedir(), ".omp", "agent", "agent.db"), {
      readonly: true,
    });
    try {
      db.run("PRAGMA busy_timeout = 2000");
      const rows = db
        .query(
          "SELECT id, data FROM auth_credentials WHERE provider='openai-codex' " +
            "AND credential_type='oauth' AND disabled_cause IS NULL " +
            "ORDER BY id DESC",
        )
        .all() as Array<{ id: number; data: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          if (typeof parsed.access !== "string" || !parsed.access) continue;
          creds.push({
            key: String(row.id),
            access: parsed.access,
            accountId:
              typeof parsed.accountId === "string" && parsed.accountId
                ? parsed.accountId
                : undefined,
            email:
              typeof parsed.email === "string" && parsed.email
                ? parsed.email
                : undefined,
          });
        } catch {
          /* try next row */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* fall through with whatever was parsed */
  }
  return creds;
}

export async function fetchCodex(
  force: boolean,
  log?: (...args: unknown[]) => void,
): Promise<CodexAccount[] | undefined> {
  if (!ENABLED) return undefined;
  const creds = readCodexCreds();
  if (creds.length === 0) {
    log?.("quota-board: no openai-codex oauth token in agent.db; codex quota disabled");
    return codexAccounts;
  }
  const entries = await Promise.all(
    creds.map(async (cred): Promise<CodexAccount | undefined> => {
      const prev = codexAccounts?.find((e) => e.key === cred.key);
      if (!force && prev && Date.now() - prev.state.fetchedAt < TTL_MS) return prev;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${cred.access}`,
        "User-Agent": "omp-quota-board",
      };
      if (cred.accountId) headers["ChatGPT-Account-Id"] = cred.accountId;
      try {
        const data = await fetchJson(CODEX_URL, headers);
        const rl = data.rate_limit as Record<string, unknown> | null | undefined;
        const credits = data.credits as Record<string, unknown> | null | undefined;
        return {
          key: cred.key,
          email: cred.email,
          state: {
            plan: typeof data.plan_type === "string" ? data.plan_type : undefined,
            primary: parseCodexWindow(rl?.primary_window),
            secondary: parseCodexWindow(rl?.secondary_window),
            creditsBalance:
              credits && typeof credits.balance === "string"
                ? credits.balance
                : undefined,
            fetchedAt: Date.now(),
          },
        };
      } catch (err) {
        log?.(
          `quota-board: codex(${cred.email ?? cred.key}) fetch failed: ${String(err)}`,
        );
        return prev; // stale on failure
      }
    }),
  );
  codexAccounts = entries.filter((e): e is CodexAccount => e !== undefined);
  return codexAccounts;
}

export function codexText(s: CodexState, label = "codex"): string | undefined {
  const parts: string[] = [];
  const w = s.primary ?? s.secondary;
  if (w) {
    let text = `${label} ${w.label} ${w.pct}%`;
    if (w.resetMs > 0) text += ` (${fmtDuration(w.resetMs - Date.now())})`;
    parts.push(text);
  }
  const other = s.primary && s.secondary ? s.secondary : undefined;
  if (other) {
    let text = `${other.label} ${other.pct}%`;
    if (other.resetMs > 0) text += ` (${fmtDuration(other.resetMs - Date.now())})`;
    parts.push(text);
  }
  if (parts.length === 0) return undefined;
  // A zero balance renders as "cr 0", which is pure noise on the bar; drop it.
  const credits = s.creditsBalance ? fmtCredits(s.creditsBalance) : undefined;
  if (credits && credits !== "0") parts.push(`cr ${credits}`);
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
    const period = config?.currentPeriod as Record<string, unknown> | undefined;
    const type = typeof period?.type === "string" ? period.type : "";
    // Proto3 JSON omits zero-valued fields: an absent creditUsagePercent
    // with a current period means 0% used, not a malformed response (seen
    // 2026-08-27 right after a period reset; same call as upstream
    // opencode-quota src/lib/xai.ts parseCreditsWindow).
    const hasUsage =
      config !== undefined && Object.hasOwn(config, "creditUsagePercent");
    const hasPeriod =
      type !== "" ||
      typeof period?.start === "string" ||
      typeof period?.end === "string";
    const pct = hasUsage ? config?.creditUsagePercent : 0;
    if (!hasPeriod && !hasUsage)
      throw new Error("unexpected billing response shape");
    if (typeof pct !== "number" || !Number.isFinite(pct))
      throw new Error("unexpected billing response shape");
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
  if (s.resetMs > 0) text += ` (${fmtDuration(s.resetMs - Date.now())})`;
  return text;
}

// --- go (OpenCode Go plan) --------------------------------------------------

interface OcgoState {
  rolling?: Win;
  weekly?: Win;
  monthly?: Win;
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
      weekly: parseOcgoWindow(usage.weekly),
      monthly: parseOcgoWindow(usage.monthly),
      fetchedAt: Date.now(),
    };
  } catch (err) {
    log?.(`quota-board: go fetch failed: ${String(err)}`);
  }
  return ocgoCache; // stale on failure
}

export function ocgoText(s: OcgoState): string | undefined {
  if (!s.rolling && !s.weekly && !s.monthly) return undefined;
  const parts: string[] = [];
  if (s.rolling) {
    let text = `go 5h ${s.rolling.pct}%`;
    if (s.rolling.resetMs > 0)
      text += ` (${fmtDuration(s.rolling.resetMs - Date.now())})`;
    parts.push(text);
  }
  for (const [label, win] of [
    ["wk", s.weekly],
    ["mo", s.monthly],
  ] as const) {
    if (!win) continue;
    let text = `${label} ${win.pct}%`;
    if (win.resetMs > 0) text += ` (${fmtDuration(win.resetMs - Date.now())})`;
    parts.push(text);
  }
  return parts.join(" ");
}

// --- goog (Google Antigravity) ----------------------------------------------

interface AgyPool {
  fiveHour?: Win;
  weekly?: Win;
}

export interface AgyState {
  gemini: AgyPool;
  thirdParty: AgyPool; // Claude and GPT models share a separate pool
  fetchedAt: number;
}

export interface AgyAccount {
  key: string; // agent.db credential row id — stable anchor for cache & order
  email?: string;
  projectId?: string;
  state: AgyState;
}

let agyAccounts: AgyAccount[] | undefined;

interface AgyCred {
  key: string;
  access: string;
  projectId: string;
  email?: string;
}

/** All logged-in google-antigravity oauth rows, oldest credential first. */
function readAgyCreds(): AgyCred[] {
  const creds: AgyCred[] = [];
  try {
    const db = new Database(join(homedir(), ".omp", "agent", "agent.db"), {
      readonly: true,
    });
    try {
      db.run("PRAGMA busy_timeout = 2000");
      const rows = db
        .query(
          "SELECT id, data FROM auth_credentials WHERE provider='google-antigravity' " +
            "AND credential_type='oauth' AND disabled_cause IS NULL " +
            "ORDER BY id ASC",
        )
        .all() as Array<{ id: number; data: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          if (typeof parsed.access !== "string" || !parsed.access) continue;
          if (typeof parsed.projectId !== "string" || !parsed.projectId) continue;
          creds.push({
            key: String(row.id),
            access: parsed.access,
            projectId: parsed.projectId,
            email:
              typeof parsed.email === "string" && parsed.email
                ? parsed.email
                : undefined,
          });
        } catch {
          /* try next row */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* fall through with whatever was parsed */
  }
  return creds;
}

function parseAgyWindow(raw: unknown): Win | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  if (b.disabled === true) return undefined;
  const fraction = b.remainingFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return undefined;
  const resetMs = typeof b.resetTime === "string" ? Date.parse(b.resetTime) : NaN;
  return {
    pct: Math.round((1 - Math.min(1, Math.max(0, fraction))) * 100),
    resetMs: Number.isFinite(resetMs) ? resetMs : 0,
  };
}

export async function fetchAgy(
  force: boolean,
  log?: (...args: unknown[]) => void,
): Promise<AgyAccount[] | undefined> {
  if (!ENABLED) return undefined;
  const creds = readAgyCreds();
  if (creds.length === 0) {
    log?.(
      "quota-board: no google-antigravity oauth access/projectId in agent.db; goog quota disabled",
    );
    return agyAccounts;
  }
  const entries = await Promise.all(
    creds.map(async (cred): Promise<AgyAccount | undefined> => {
      const prev = agyAccounts?.find((e) => e.key === cred.key);
      if (!force && prev && Date.now() - prev.state.fetchedAt < TTL_MS) return prev;
      try {
        const payload = await fetchJson(
          AGY_URL,
          {
            Authorization: `Bearer ${cred.access}`,
            "User-Agent": AGY_UA,
            "x-activity-request-id": crypto.randomUUID(),
          },
          { method: "POST", body: JSON.stringify({ project: cred.projectId }) },
        );
        const groups = payload.groups;
        if (!Array.isArray(groups)) throw new Error("unexpected response shape");
        const state: AgyState = { gemini: {}, thirdParty: {}, fetchedAt: Date.now() };
        for (const group of groups as Array<Record<string, unknown>>) {
          const name =
            typeof group.displayName === "string" ? group.displayName.toLowerCase() : "";
          const pool = name.includes("gemini")
            ? state.gemini
            : name.includes("claude") || name.includes("gpt")
              ? state.thirdParty
              : undefined;
          if (!pool || !Array.isArray(group.buckets)) continue;
          for (const bucket of group.buckets as Array<Record<string, unknown>>) {
            const win = parseAgyWindow(bucket);
            if (!win) continue;
            const kind =
              typeof bucket.window === "string"
                ? bucket.window.toUpperCase().replace(/[\s-]+/g, "_")
                : "";
            if (kind === "WEEKLY" && !pool.weekly) pool.weekly = win;
            else if ((kind === "FIVE_HOUR" || kind === "5H") && !pool.fiveHour)
              pool.fiveHour = win;
          }
        }
        if (
          !state.gemini.fiveHour &&
          !state.gemini.weekly &&
          !state.thirdParty.fiveHour &&
          !state.thirdParty.weekly
        )
          throw new Error("no quota buckets parsed");
        return {
          key: cred.key,
          email: cred.email,
          projectId: cred.projectId,
          state,
        };
      } catch (err) {
        log?.(
          `quota-board: goog(${cred.email ?? cred.key}) fetch failed: ${String(err)}`,
        );
        return prev; // stale on failure
      }
    }),
  );
  agyAccounts = entries.filter((e): e is AgyAccount => e !== undefined);
  return agyAccounts;
}

function tighterWindow(a: Win | undefined, b: Win | undefined): Win | undefined {
  if (!a) return b;
  if (!b) return a;
  return (b.pct ?? 0) > (a.pct ?? 0) ? b : a;
}

export function agyText(s: AgyState, label = "goog"): string | undefined {
  // Status bar shows the tighter of the two pools per window (early warning);
  // /quota lists both pools in full.
  const fiveHour = tighterWindow(s.gemini.fiveHour, s.thirdParty.fiveHour);
  const weekly = tighterWindow(s.gemini.weekly, s.thirdParty.weekly);
  if (!fiveHour && !weekly) return undefined;
  const parts: string[] = [];
  if (fiveHour) {
    let text = `${label} 5h ${fiveHour.pct}%`;
    if (fiveHour.resetMs > 0)
      text += ` (${fmtDuration(fiveHour.resetMs - Date.now())})`;
    parts.push(text);
  }
  if (weekly) {
    let text = `wk ${weekly.pct}%`;
    if (weekly.resetMs > 0)
      text += ` (${fmtDuration(weekly.resetMs - Date.now())})`;
    parts.push(text);
  }
  return parts.join(" ");
}

// --- hook wiring -----------------------------------------------------------

let sessionTurnCount = 0;

export default function quotaBoard(pi: HookAPI): void {
  const log = (...args: unknown[]) => pi.logger?.warn?.(...(args as [string]));
  const refreshStatus = async (ctx: {
    ui?: { setStatus?: (k: string, t: string | undefined) => void };
  }) => {
    const [glm, codexSegs, grok, ocgo, agySegs] = await Promise.all([
      fetchGlm(false, log).then((s) => s && glmText(s)),
      fetchCodex(false, log).then((accs) =>
        (accs ?? []).map((a, i) =>
          codexText(a.state, (accs?.length ?? 0) > 1 ? `codex${i + 1}` : "codex"),
        ),
      ),
      fetchGrok(false, log).then((s) => s && grokText(s)),
      fetchOcgo(false, log).then((s) => s && ocgoText(s)),
      fetchAgy(false, log).then((accs) =>
        (accs ?? []).map((a, i) =>
          agyText(a.state, (accs?.length ?? 0) > 1 ? `goog${i + 1}` : "goog"),
        ),
      ),
    ]);
    // Split into 2 rows so multiple accounts don't truncate on typical terminal widths:
    // Row 1: turns | codex...
    // Row 2: glm | grok | goog... | go (ocgo)
    const turnText =
      sessionTurnCount >= 60
        ? `🚨 会话 ${sessionTurnCount} 轮`
        : sessionTurnCount >= 40
          ? `⚠️ 会话 ${sessionTurnCount} 轮`
          : `会话 ${sessionTurnCount} 轮`;
    const line1 = [turnText, ...codexSegs].filter((t): t is string => typeof t === "string").join(" | ");
    const line2 = [glm, grok, ...(agySegs ?? []), ocgo].filter((t): t is string => typeof t === "string").join(" | ");

    // Clear legacy single-row key if present
    ctx.ui?.setStatus?.("quota-board", undefined);

    ctx.ui?.setStatus?.("quota-board-1", line1 || undefined);
    ctx.ui?.setStatus?.("quota-board-2", line2 || undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionTurnCount = 0;
    await refreshStatus(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    sessionTurnCount++;
    await refreshStatus(ctx);
  });

  try {
    pi.registerCommand("quota", {
      description: "GLM / Codex / Grok / OpenCode Go / Google Antigravity quota report",
      handler: async (_args, ctx) => {
        const [glm, codex, grok, ocgo, agy] = await Promise.all([
          fetchGlm(true, log),
          fetchCodex(true, log),
          fetchGrok(true, log),
          fetchOcgo(true, log),
          fetchAgy(true, log),
        ]);
        const lines: string[] = [
          "Quota board (glm / codex / grok / opencode go / google antigravity)",
        ];
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
        if (codex && codex.length > 0) {
          codex.forEach((acc, i) => {
            const label = codex.length > 1 ? `codex${i + 1}` : "codex";
            const s = acc.state;
            const who = acc.email ? ` <${acc.email}>` : "";
            lines.push(
              `  ${label} (${s.plan ?? "?"})${who}: ` +
                (s.primary
                  ? `${s.primary.label} ${s.primary.pct}%` +
                    (s.primary.resetMs > 0
                      ? `, resets ${fmtLocal(s.primary.resetMs)}`
                      : "")
                  : "no window") +
                (s.secondary
                  ? ` | ${s.secondary.label} ${s.secondary.pct}%`
                  : "") +
                (s.creditsBalance ? ` | credits ${fmtCredits(s.creditsBalance)}` : ""),
            );
          });
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
          if (ocgo.weekly) bits.push(`wk ${ocgo.weekly.pct}%`);
          if (ocgo.monthly) bits.push(`mo ${ocgo.monthly.pct}%`);
          lines.push(`  go   : ${bits.join(" | ") || "no windows"}`);
        } else {
          lines.push("  go   : unavailable (no api key or fetch failed)");
        }
        if (agy && agy.length > 0) {
          agy.forEach((acc, i) => {
            const label = agy.length > 1 ? `goog${i + 1}` : "goog";
            const s = acc.state;
            const who = acc.email ? ` <${acc.email}>` : "";
            const bits: string[] = [];
            for (const [pool, pLabel] of [
              [s.gemini, "gemini"],
              [s.thirdParty, "claude/gpt"],
            ] as const) {
              const ws: string[] = [];
              if (pool.fiveHour)
                ws.push(
                  `5h ${pool.fiveHour.pct}%` +
                    (pool.fiveHour.resetMs > 0
                      ? ` (resets ${fmtLocal(pool.fiveHour.resetMs)})`
                      : ""),
                );
              if (pool.weekly)
                ws.push(
                  `wk ${pool.weekly.pct}%` +
                    (pool.weekly.resetMs > 0
                      ? ` (resets ${fmtLocal(pool.weekly.resetMs)})`
                      : ""),
                );
              if (ws.length > 0) bits.push(`${pLabel} ${ws.join(", ")}`);
            }
            lines.push(`  ${label}${who}: ${bits.join(" | ") || "no windows"}`);
          });
        } else {
          lines.push(
            "  goog : unavailable (no oauth token in agent.db or fetch failed)",
          );
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
