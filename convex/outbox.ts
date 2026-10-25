import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api.js";
import { action, internalAction, internalMutation, internalQuery, mutation } from "./_generated/server.js";
import { requireServiceToken } from "./lib/auth.js";
import { requireOperateIdentity } from "./lib/webAccess.js";
import { appId, assertUUID } from "./lib/validators.js";

export const outboxPool = new Workpool(components.outboxPool, { maxParallelism: 2 });

export const insert = internalMutation({
  args: {
    destination: v.union(v.literal("elastic_index"), v.literal("jira_sync"), v.literal("confluence_link")),
    idempotencyKey: v.string(),
    operationId: v.string(),
    payload: v.any(),
    source: v.union(v.literal("convex"), v.literal("spacetimedb")),
  },
  handler: async (ctx, args): Promise<any> => {
    const existing = await ctx.db.query("outbox")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing) return { receiptId: existing.appId, duplicate: true };
    if (args.idempotencyKey.length < 8) throw new ConvexError("idempotencyKey_too_short");
    assertUUID(args.operationId, "operationId");
    const now = Date.now();
    const receiptId = appId();
    await ctx.db.insert("outbox", {
      appId: receiptId,
      destination: args.destination,
      status: "pending",
      idempotencyKey: args.idempotencyKey,
      operationId: args.operationId,
      payload: args.payload,
      attempts: 0,
      createdAtMs: now,
      source: args.source,
      nextAttemptAtMs: now,
    });
    const dispatch: any = internal.outbox.dispatchOne;
    await outboxPool.enqueueAction(ctx, dispatch, { receiptId });
    return { receiptId, duplicate: false };
  },
});

export const requeue = internalMutation({
  args: { receiptIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ requeued: number; skipped: number }> => {
    if (args.receiptIds.length > 100) throw new ConvexError("too_many_receipt_ids");
    const dispatch: any = internal.outbox.dispatchOne;
    let requeued = 0;
    let skipped = 0;
    for (const receiptId of args.receiptIds) {
      const entry = await ctx.db.query("outbox")
        .withIndex("by_appId", (q) => q.eq("appId", receiptId))
        .unique();
      if (!entry || entry.status === "delivered" || entry.lastError === "not_implemented") {
        skipped += 1;
        continue;
      }
      if (entry.status !== "dead" && entry.status !== "pending") {
        skipped += 1;
        continue;
      }
      const now = Date.now();
      await ctx.db.patch(entry._id, {
        status: "pending",
        attempts: 0,
        lastError: undefined,
        deliveredAtMs: undefined,
        nextAttemptAtMs: now,
      });
      await outboxPool.enqueueAction(ctx, dispatch, { receiptId: entry.appId });
      requeued += 1;
    }
    return { requeued, skipped };
  },
});

export const sweepDead = mutation({
  args: { serviceToken: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    await requireOperateIdentity(ctx, args.serviceToken);
    const dead = await ctx.db.query("outbox").withIndex("by_status_next", (q) => q.eq("status", "dead")).collect();
    for (const entry of dead) await ctx.db.delete(entry._id);
    return { deleted: dead.length };
  },
});

export const ingestFromSpacetime = action({
  args: {
    operationId: v.string(),
    destination: v.union(v.literal("elastic_index"), v.literal("jira_sync"), v.literal("confluence_link")),
    payload: v.any(),
    idempotencyKey: v.string(),
    serviceToken: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    requireServiceToken(args.serviceToken);
    return await ctx.runMutation(internal.outbox.insert, {
      destination: args.destination,
      idempotencyKey: args.idempotencyKey,
      operationId: args.operationId,
      payload: args.payload,
      source: "spacetimedb",
    });
  },
});

export const getEntry = internalQuery({
  args: { receiptId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("outbox")
    .withIndex("by_appId", (q) => q.eq("appId", args.receiptId))
    .unique(),
});

export const updateDispatch = internalMutation({
  args: {
    receiptId: v.string(),
    delivered: v.boolean(),
    notImplemented: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const entry = await ctx.db.query("outbox")
      .withIndex("by_appId", (q) => q.eq("appId", args.receiptId))
      .unique();
    if (!entry || entry.status !== "pending") return { updated: false };
    const now = Date.now();
    if (args.delivered) {
      await ctx.db.patch(entry._id, { status: "delivered", deliveredAtMs: now });
      return { updated: true };
    }
    if (args.notImplemented) {
      await ctx.db.patch(entry._id, {
        nextAttemptAtMs: now + 300_000,
        lastError: args.error ?? "not_implemented",
      });
      return { updated: true };
    }
    const attempts = entry.attempts + 1;
    const dead = attempts >= 8;
    await ctx.db.patch(entry._id, {
      attempts,
      status: dead ? "dead" : "pending",
      lastError: args.error ?? "dispatch_failed",
      nextAttemptAtMs: now + Math.min(600_000, 5_000 * 2 ** attempts),
    });
    if (!dead) await ctx.scheduler.runAfter(Math.min(600_000, 5_000 * 2 ** attempts), internal.outbox.dispatchOne, { receiptId: entry.appId });
    return { updated: true, dead };
  },
});

export const dispatchOne = internalAction({
  args: { receiptId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const entry: any = await ctx.runQuery(internal.outbox.getEntry, args);
    if (!entry || entry.status !== "pending") return { delivered: false };
    try {
      const result = entry.destination === "jira_sync" || entry.destination === "confluence_link"
        ? await ctx.runAction(internal.dispatchers.jira.dispatch, { payload: entry.payload })
        : await ctx.runAction(internal.dispatchers.elastic.dispatch, { payload: entry.payload });
      await ctx.runMutation(internal.outbox.updateDispatch, {
        receiptId: entry.appId,
        delivered: result.delivered,
        notImplemented: result.mode === "not_implemented",
        error: result.reason,
      });
      return result;
    } catch {
      await ctx.runMutation(internal.outbox.updateDispatch, {
        receiptId: entry.appId,
        delivered: false,
        notImplemented: false,
        error: "destination_dispatch_failed",
      });
      return { delivered: false };
    }
  },
});
