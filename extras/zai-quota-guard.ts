import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { fetchGlm, fmtDuration, fmtLocal, type GlmState } from "./quota-board.ts";

/**
 * GLM quota policy layer (companion to quota-board.ts, which owns all quota
 * fetching and the status row — including the glm segment).
 *
 * Origin: this hook predates the board — it was first written as a standalone
 * guard for the author's primary model (GLM), and became an optional extra
 * once the board took over data fetching. It is GLM-only on purpose: the gate
 * intercepts subagent fan-out because fan-out burns the DEFAULT model's
 * quota, which is GLM in this setup. For other providers, whether a fan-out
 * bills them depends on your OMP model roles, so a generic blocker would
 * guess wrong — see README "Why there is no codex / grok / go guard".
 *
 * What this hook adds on top of the display:
 *  - warn toast when the 5h window crosses ZAI_QUOTA_WARN_PCT (default 75)
 *  - gate: subagent fan-out (task tool) requires confirmation once the 5h
 *    window reaches ZAI_QUOTA_GATE_PCT (default 90); headless/subagent
 *    contexts are blocked with an instructive reason instead
 *  - /glm slash command: full GLM quota report
 *
 * All GLM data comes from quota-board's fetchGlm (shared cache & TTL, so
 * the two hooks never double-fetch z.ai). Removing quota-board.ts disables
 * this hook's data source.
 *
 * Env knobs: ZAI_QUOTA_GUARD=0 disables everything; ZAI_QUOTA_WARN_PCT,
 * ZAI_QUOTA_GATE_PCT tune behavior. Refresh TTL is shared with the board
 * (QUOTA_BOARD_TTL_MS, default 120s).
 */

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const WARN_PCT = envNum("ZAI_QUOTA_WARN_PCT", 75);
const GATE_PCT = envNum("ZAI_QUOTA_GATE_PCT", 90);
const ENABLED = !/^(0|false|off)$/i.test(process.env.ZAI_QUOTA_GUARD ?? "1");

let warnedAtPct = -1;

function fullReport(q: GlmState): string {
  const lines = [`GLM Coding Plan quota (level: ${q.level ?? "?"})`];
  if (q.fiveHour) {
    lines.push(
      `  5h window : ${q.fiveHour.pct ?? "?"}% used, resets ${fmtLocal(q.fiveHour.resetMs)} ` +
        `(in ${fmtDuration(q.fiveHour.resetMs - Date.now())})`,
    );
  }
  if (q.weekly) {
    lines.push(
      `  weekly    : ${q.weekly.pct ?? "?"}% used, resets ${fmtLocal(q.weekly.resetMs)} ` +
        `(in ${fmtDuration(q.weekly.resetMs - Date.now())})`,
    );
  }
  for (const s of q.searches) {
    const details = Array.isArray(s.usageDetails)
      ? (s.usageDetails as Array<Record<string, unknown>>)
          .map((d) => `${d.modelCode} ${d.usage}`)
          .join(", ")
      : "";
    lines.push(
      `  searches  : ${s.currentValue}/${s.usage} used (${s.percentage}%), ` +
        `resets ${typeof s.nextResetTime === "number" ? fmtLocal(s.nextResetTime) : "?"}` +
        (details ? ` [${details}]` : ""),
    );
  }
  lines.push(`  knobs     : warn>=${WARN_PCT}% gate>=${GATE_PCT}% (ZAI_QUOTA_*)`);
  lines.push(`  fetched   : ${fmtLocal(q.fetchedAt)}`);
  return lines.join("\n");
}

export default function zaiQuotaGuard(pi: HookAPI): void {
  const log = (...args: unknown[]) => pi.logger?.warn?.(...(args as [string]));

  const checkWarn = async (ctx: { ui?: { notify?: (t: string) => void } }) => {
    if (!ENABLED) return;
    const q = await fetchGlm(false, log);
    const pctNow = q?.fiveHour?.pct;
    if (pctNow === undefined) return;
    if (pctNow >= WARN_PCT && warnedAtPct < WARN_PCT) {
      ctx.ui?.notify?.(
        `GLM 5h window at ${pctNow}% (resets ${q?.fiveHour ? fmtLocal(q.fiveHour.resetMs) : "?"})`,
      );
    }
    warnedAtPct = pctNow;
  };

  pi.on("session_start", async (_event, ctx) => {
    await checkWarn(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    await checkWarn(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return;
    if (!ENABLED) return;
    const q = await fetchGlm(false, log);
    const pctNow = q?.fiveHour?.pct;
    if (pctNow === undefined || pctNow < GATE_PCT) return;
    const reset = q?.fiveHour ? fmtLocal(q.fiveHour.resetMs) : "?";
    const message =
      `GLM 5h quota window is at ${pctNow}% (resets ${reset}). ` +
      `Subagent fan-out burns quota in parallel; the guard throttles it at ${GATE_PCT}%.`;
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm("GLM quota guard", message);
      if (ok) return;
      return {
        block: true,
        reason: `Blocked by GLM quota guard (5h window ${pctNow}%): user declined subagent fan-out. Do the work directly in this session instead.`,
      };
    }
    return {
      block: true,
      reason:
        `Blocked by GLM quota guard: 5h window at ${pctNow}% (resets ${reset}); ` +
        `subagent fan-out is throttled to conserve quota. Do the work directly in this ` +
        `session (no subagents), avoid re-reading large files, and keep outputs tight. ` +
        `Raise the limit with env ZAI_QUOTA_GATE_PCT=<higher> if this is wrong.`,
    };
  });

  try {
    pi.registerCommand("glm", {
      description: "GLM Coding Plan quota report (5h window / weekly / searches)",
      handler: async (_args, ctx) => {
        const q = await fetchGlm(true, log);
        if (!q) {
          ctx.ui?.notify?.("glm quota unavailable: no zai api key (env/agent.db) or fetch failed — see hook logs");
          return;
        }
        ctx.ui?.notify?.(fullReport(q));
      },
    });
  } catch (err) {
    log?.(`zai-quota-guard: registerCommand('glm') failed: ${String(err)}`);
  }
}
