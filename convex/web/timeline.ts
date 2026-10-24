import { v } from "convex/values";
import { query } from "../_generated/server.js";
import { assertUUID } from "../lib/validators.js";
import { requireInvestigationRead } from "../lib/webAccess.js";

const MAX_JOBS = 500;

/** Web: `web/timeline:handoffs`. Durable handoff steps of every job in one
 *  investigation, oldest first; read-only. */
export const handoffs = query({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => {
    assertUUID(args.investigationId, "investigationId");
    await requireInvestigationRead(ctx, args.investigationId);
    const jobs = await ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).take(MAX_JOBS);
    const out: { jobId: string; jobKind: string; environmentId?: string; stage: string; atMs: number; stale: boolean }[] = [];
    for (const job of jobs) {
      const rows = await ctx.db.query("handoffs").withIndex("by_job", (q) => q.eq("jobId", job.appId)).take(50);
      for (const h of rows) {
        out.push({
          jobId: job.appId, jobKind: job.kind, ...(job.environmentId ? { environmentId: job.environmentId } : {}),
          stage: h.stage, atMs: h.atMs, stale: h.stale,
        });
      }
    }
    return out.sort((a, b) => a.atMs - b.atMs);
  },
});
