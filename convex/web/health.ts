import { query } from "../_generated/server.js";
import { UnauthorizedError, isLocalDeployment } from "../lib/auth.js";
import { readLimits } from "../lib/constants.js";
import { hasPrivateAccess } from "../lib/webAccess.js";

/** Sandbox states that still hold (or may hold) a slot against the org cap. */
export const SANDBOX_HOLDING = ["requested", "creating", "ready", "ambiguous_create", "terminating", "ambiguous_terminate"] as const;
const SCAN = 1000;

/** Web: `web/health:pipeline`. Read-only counters for the health page;
 *  signed-in users or the integration service token only. */
export const pipeline = query({
  args: {},
  handler: async (ctx) => {
    if (!await hasPrivateAccess(ctx)) throw new UnauthorizedError();
    const now = Date.now();
    let activeSandboxes = 0;
    for (const status of SANDBOX_HOLDING) {
      activeSandboxes += (await ctx.db.query("sandboxOps").withIndex("by_status", (q) => q.eq("status", status)).take(SCAN)).length;
    }
    const pending = await ctx.db.query("outbox").withIndex("by_status_next", (q) => q.eq("status", "pending")).take(SCAN);
    const dead = await ctx.db.query("outbox").withIndex("by_status_next", (q) => q.eq("status", "dead")).take(SCAN);
    const failedEvaluationCommits = await ctx.db.query("evaluations")
      .withIndex("by_commitStatus", (q) => q.eq("commitStatus", "commit_failed"))
      .take(SCAN);
    const credentials = await ctx.db.query("runnerCredentials").order("desc").take(SCAN);
    const runners = credentials.filter((c) => !c.revokedAtMs && c.expiresAtMs > now).length;
    const sessions = await ctx.db.query("sessions").order("desc").take(SCAN);
    const unknownUsageTurns = sessions.reduce((total, session) => total + (session.usageUnknownTurns ?? 0), 0);
    const oldest = pending.reduce<number | undefined>((min, row) => (min === undefined || row.createdAtMs < min ? row.createdAtMs : min), undefined);
    return {
      mode: isLocalDeployment() ? ("local" as const) : ("live" as const),
      checkedAtMs: now,
      activeSandboxes,
      sandboxCap: readLimits().maxActiveSandboxes,
      runners,
      unknownUsageTurns,
      outboxBacklog: pending.length,
      outboxDead: dead.length,
      failedEvaluationCommits: failedEvaluationCommits.length,
      deadRows: {
        total: dead.length + failedEvaluationCommits.length,
        evaluations: failedEvaluationCommits.length,
        outbox: dead.length,
      },
      ...(oldest !== undefined ? { oldestBacklogAtMs: oldest } : {}),
    };
  },
});
