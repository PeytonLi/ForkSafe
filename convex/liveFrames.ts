import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

export const LIVE_MAX_CHUNKS = 120;
export const LIVE_MAX_FRAMES_PER_CHUNK = 20;
export const LIVE_MAX_CHUNK_BYTES = 64_000;
export const LIVE_CLEANUP_DELAY_MS = 60_000;
export const LIVE_STALE_MS = 10 * 60_000;
export const LIVE_WINDOW_CHUNKS = 8;

export const open = internalMutation({
  args: { experimentId: v.string(), investigationId: v.string(), environmentId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("liveStreams").withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId)).unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { updatedAtMs: now });
      return { opened: false };
    }
    await ctx.db.insert("liveStreams", {
      ...args,
      status: "waiting",
      nextSeq: 0,
      chunkCount: 0,
      compacted: false,
      createdAtMs: now,
      updatedAtMs: now,
    });
    return { opened: true };
  },
});

export const appendChunk = internalMutation({
  args: { experimentId: v.string(), seq: v.number(), frames: v.array(v.any()), final: v.boolean() },
  handler: async (ctx, args): Promise<
    { accepted: true } | { accepted: false; reason: "duplicate" | "gap" | "capped" | "too_large" | "closed" | "missing" }
  > => {
    const stream = await ctx.db.query("liveStreams").withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId)).unique();
    if (!stream) return { accepted: false, reason: "missing" };
    const existing = await ctx.db.query("liveChunks")
      .withIndex("by_experiment_seq", (q) => q.eq("experimentId", args.experimentId).eq("seq", args.seq))
      .unique();
    if (existing || args.seq < stream.nextSeq) return { accepted: false, reason: "duplicate" };
    if (args.seq > stream.nextSeq) return { accepted: false, reason: "gap" };
    if (stream.status === "finished" || stream.status === "unavailable") return { accepted: false, reason: "closed" };

    const bytes = new TextEncoder().encode(JSON.stringify(args.frames)).byteLength;
    if (args.frames.length > LIVE_MAX_FRAMES_PER_CHUNK || bytes > LIVE_MAX_CHUNK_BYTES) {
      await ctx.db.patch(stream._id, { status: "unavailable", reason: "chunk_too_large", updatedAtMs: Date.now() });
      return { accepted: false, reason: "too_large" };
    }
    if (stream.chunkCount >= LIVE_MAX_CHUNKS) {
      await ctx.db.patch(stream._id, { status: "unavailable", reason: "chunk_cap", updatedAtMs: Date.now() });
      return { accepted: false, reason: "capped" };
    }
    const lastFrame = args.frames.at(-1) as { tSec?: unknown } | undefined;
    await ctx.db.insert("liveChunks", {
      experimentId: args.experimentId,
      seq: args.seq,
      frames: args.frames,
      tEndSec: typeof lastFrame?.tSec === "number" ? lastFrame.tSec : 0,
      final: args.final,
      createdAtMs: Date.now(),
    });
    await ctx.db.patch(stream._id, {
      nextSeq: args.seq + 1,
      chunkCount: stream.chunkCount + 1,
      status: "streaming",
      updatedAtMs: Date.now(),
    });
    return { accepted: true };
  },
});

export const finish = internalMutation({
  args: {
    experimentId: v.string(),
    outcome: v.union(v.literal("finished"), v.literal("unavailable")),
    replayArtifactId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const stream = await ctx.db.query("liveStreams").withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId)).unique();
    if (!stream) return { finished: false };
    const now = Date.now();
    await ctx.db.patch(stream._id, {
      status: stream.status === "unavailable" && args.outcome === "finished" ? "unavailable" : args.outcome,
      ...((stream.status === "unavailable" && stream.reason) || !args.reason ? {} : { reason: args.reason }),
      ...(args.replayArtifactId ? { replayArtifactId: args.replayArtifactId } : {}),
      updatedAtMs: now,
    });
    await ctx.scheduler.runAfter(LIVE_CLEANUP_DELAY_MS, internal.liveFrames.cleanup, { experimentId: args.experimentId });
    return { finished: true };
  },
});

export const cleanup = internalMutation({
  args: { experimentId: v.string() },
  handler: async (ctx, args) => {
    const stream = await ctx.db.query("liveStreams").withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId)).unique();
    if (!stream) return { deleted: 0, compacted: true };
    const chunks = await ctx.db.query("liveChunks")
      .withIndex("by_experiment_seq", (q) => q.eq("experimentId", args.experimentId))
      .order("asc")
      .take(65);
    for (const chunk of chunks.slice(0, 64)) await ctx.db.delete(chunk._id);
    const remaining = chunks.length > 64;
    if (remaining) {
      await ctx.scheduler.runAfter(0, internal.liveFrames.cleanup, { experimentId: args.experimentId });
    } else {
      await ctx.db.patch(stream._id, { compacted: true, chunkCount: 0, updatedAtMs: Date.now() });
    }
    return { deleted: Math.min(chunks.length, 64), compacted: !remaining };
  },
});

export const sweepStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let examined = 0;
    for (const status of ["waiting", "streaming"] as const) {
      const rows = await ctx.db.query("liveStreams")
        .withIndex("by_status_updated", (q) => q.eq("status", status).lt("updatedAtMs", now - LIVE_STALE_MS))
        .take(50 - examined);
      examined += rows.length;
      for (const row of rows) {
        await ctx.db.patch(row._id, { status: "unavailable", reason: "relay_stale", updatedAtMs: now });
        await ctx.scheduler.runAfter(LIVE_CLEANUP_DELAY_MS, internal.liveFrames.cleanup, { experimentId: row.experimentId });
      }
      if (examined >= 50) return { examined };
    }
    for (const status of ["finished", "unavailable"] as const) {
      const rows = await ctx.db.query("liveStreams")
        .withIndex("by_status_updated", (q) => q.eq("status", status).lt("updatedAtMs", now - 2 * LIVE_CLEANUP_DELAY_MS))
        .take(50 - examined);
      examined += rows.length;
      for (const row of rows) {
        if (!row.compacted) await ctx.scheduler.runAfter(0, internal.liveFrames.cleanup, { experimentId: row.experimentId });
      }
      if (examined >= 50) break;
    }
    return { examined };
  },
});
