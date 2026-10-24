import { query } from "../_generated/server.js";

export const pipeline = query({
  args: {},
  handler: async (ctx) => {
    const [failedEvaluations, deadOutboxRows] = await Promise.all([
      ctx.db.query("evaluations")
        .withIndex("by_commitStatus", (q) => q.eq("commitStatus", "commit_failed"))
        .collect(),
      ctx.db.query("outbox")
        .withIndex("by_status_next", (q) => q.eq("status", "dead"))
        .collect(),
    ]);
    return {
      deadRows: {
        total: failedEvaluations.length + deadOutboxRows.length,
        evaluations: failedEvaluations.length,
        outbox: deadOutboxRows.length,
      },
    };
  },
});
