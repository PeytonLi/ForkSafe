import { v } from "convex/values";
import { query } from "../_generated/server.js";
import { assertUUID } from "../lib/validators.js";
import { requireInvestigationRead } from "../lib/webAccess.js";
import { LIVE_WINDOW_CHUNKS } from "../liveFrames.js";

export const latest = query({
  args: { experimentId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    assertUUID(args.experimentId, "experimentId");
    const stream = await ctx.db.query("liveStreams")
      .withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId))
      .unique();
    if (!stream) return null;
    await requireInvestigationRead(ctx, stream.investigationId, args.serviceToken);
    const chunks = await ctx.db.query("liveChunks")
      .withIndex("by_experiment_seq", (q) => q.eq("experimentId", args.experimentId))
      .order("desc")
      .take(LIVE_WINDOW_CHUNKS);
    return {
      status: stream.status,
      reason: stream.reason,
      replayArtifactId: stream.replayArtifactId,
      nextSeq: stream.nextSeq,
      chunks: chunks.reverse().map(({ seq, final, frames }) => ({ seq, final, frames })),
    };
  },
});
