import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { readLimits } from "./lib/constants.js";
import { decideReserve, countsTowardCapacity } from "./lib/reservations.js";
import { appId, assertUUID } from "./lib/validators.js";

async function admitOp(ctx: any, op: any, activeCount: number) {
  const now = Date.now();
  await ctx.db.insert("reservations", {
    appId: op.reservationId,
    kind: "sandbox",
    status: "active",
    investigationId: op.investigationId,
    holder: {
      ...(op.jobId ? { jobId: op.jobId } : {}),
      ...(op.attemptId ? { attemptId: op.attemptId } : {}),
      sandboxOpId: op.appId,
    },
    ...(op.environmentId ? { environmentId: op.environmentId } : {}),
    operationId: op.appId,
    createdAtMs: now,
  });
  await ctx.db.patch(op._id, {
    status: "requested",
    reservedSandboxCount: activeCount,
    updatedAtMs: now,
  });
  if (op.environmentId) {
    const environment = await ctx.db.query("environments")
      .withIndex("by_appId", (q: any) => q.eq("appId", op.environmentId))
      .unique();
    if (environment?.queuedReason === "sandbox_capacity_exhausted") {
      await ctx.db.patch(environment._id, { queuedReason: undefined, queuedAtMs: undefined });
    }
  }
  if (op.provider === "local" || process.env.DAYTONA_MODE === "local") {
    const provisionJobId = appId();
    await ctx.db.insert("jobs", {
      appId: provisionJobId,
      kind: "provision_sandbox",
      state: "reserved",
      investigationId: op.investigationId,
      ...(op.environmentId ? { environmentId: op.environmentId } : {}),
      epoch: 0,
      idempotencyKey: `${op.appId}:provision`,
      payload: { sandboxOpId: op.appId },
      attemptsUsed: 0,
      maxAttempts: 2,
      operationId: appId(),
      admittedCancelEpoch: 0,
      dependsOn: [],
      createdAtMs: now,
      updatedAtMs: now,
    });
    await ctx.db.patch(op._id, { jobId: provisionJobId });
    return { sandboxOpId: op.appId, localWorkerRequired: true, jobId: provisionJobId };
  }
  await ctx.scheduler.runAfter(0, internal.daytonaPool.enqueueProvision, { sandboxOpId: op.appId });
  return { sandboxOpId: op.appId, localWorkerRequired: false };
}

export const requestSandbox = internalMutation({
  args: {
    purpose: v.union(v.literal("runner"), v.literal("execution"), v.literal("evaluator"), v.literal("bridge")),
    investigationId: v.string(),
    environmentId: v.optional(v.string()),
    jobId: v.optional(v.string()),
    attemptId: v.optional(v.string()),
    snapshot: v.string(),
    resources: v.object({ cpu: v.number(), memoryGiB: v.number(), diskGiB: v.number() }),
    provider: v.union(v.literal("daytona"), v.literal("local")),
  },
  handler: async (ctx, args) => {
    assertUUID(args.investigationId, "investigationId");
    if (args.environmentId) assertUUID(args.environmentId, "environmentId");
    if (args.jobId) assertUUID(args.jobId, "jobId");
    if (args.attemptId) assertUUID(args.attemptId, "attemptId");
    const active = await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q) => q.eq("kind", "sandbox").eq("status", "active"))
      .collect();
    const ambiguous = await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q) => q.eq("kind", "sandbox").eq("status", "retained_ambiguous"))
      .collect();
    const limits = readLimits();
    const operationId = appId();
    const reservationId = appId();
    const now = Date.now();
    const sandboxOpDbId = await ctx.db.insert("sandboxOps", {
      appId: operationId,
      purpose: args.purpose,
      investigationId: args.investigationId,
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      ...(args.jobId ? { jobId: args.jobId } : {}),
      ...(args.attemptId ? { attemptId: args.attemptId } : {}),
      snapshot: args.snapshot,
      resources: args.resources,
      provider: args.provider,
      reservedSandboxCount: active.length + ambiguous.length,
      status: "queued",
      reservationId,
      attempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });
    const currentCount = active.length + ambiguous.length;
    if (decideReserve("sandbox", currentCount, limits.maxActiveSandboxes).ok) {
      const op = await ctx.db.get(sandboxOpDbId);
      return await admitOp(ctx, op, currentCount);
    }
    if (args.environmentId) {
      const environment = await ctx.db.query("environments")
        .withIndex("by_appId", (q) => q.eq("appId", args.environmentId!))
        .unique();
      if (environment) {
        await ctx.db.patch(environment._id, {
          queuedReason: "sandbox_capacity_exhausted",
          queuedAtMs: now,
        });
      }
    }
    return { sandboxOpId: operationId, queued: true, localWorkerRequired: false };
  },
});

export const admitQueued = internalMutation({
  args: {},
  handler: async (ctx) => {
    const active = await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q) => q.eq("kind", "sandbox").eq("status", "active"))
      .collect();
    const ambiguous = await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q) => q.eq("kind", "sandbox").eq("status", "retained_ambiguous"))
      .collect();
    let activeCount = active.length + ambiguous.length;
    const limits = readLimits();
    const queued = (await ctx.db.query("sandboxOps")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect()).sort((a, b) => a.createdAtMs - b.createdAtMs);
    let admitted = 0;
    let terminated = 0;
    for (const op of queued) {
      const investigation = await ctx.db.query("investigations")
        .withIndex("by_appId", (q) => q.eq("appId", op.investigationId))
        .unique();
      if (!investigation || investigation.cancelStatus !== "none"
        || ["completed", "cancelled", "failed"].includes(investigation.state)) {
        await ctx.db.patch(op._id, {
          status: "terminated",
          lastError: "investigation_closed",
          terminatedAtMs: Date.now(),
          updatedAtMs: Date.now(),
        });
        if (op.environmentId) {
          const environment = await ctx.db.query("environments")
            .withIndex("by_appId", (q) => q.eq("appId", op.environmentId!))
            .unique();
          if (environment?.queuedReason === "sandbox_capacity_exhausted") {
            await ctx.db.patch(environment._id, { queuedReason: undefined, queuedAtMs: undefined });
          }
        }
        terminated += 1;
        continue;
      }
      if (!decideReserve("sandbox", activeCount, limits.maxActiveSandboxes).ok) continue;
      await admitOp(ctx, op, activeCount);
      activeCount += 1;
      admitted += 1;
    }
    return { admitted, terminated };
  },
});

export const terminateInvestigationOps = internalMutation({
  args: { investigationId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const ops = await ctx.db.query("sandboxOps")
      .withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId))
      .collect();
    let scheduled = 0;
    let terminated = 0;
    for (const op of ops) {
      if (["terminated", "terminating"].includes(op.status)) continue;
      if (op.status === "queued") {
        const now = Date.now();
        await ctx.db.patch(op._id, {
          status: "terminated",
          lastError: args.reason.slice(0, 100),
          terminatedAtMs: now,
          updatedAtMs: now,
        });
        const reservation = await ctx.db.query("reservations")
          .withIndex("by_operation", (q) => q.eq("operationId", op.appId))
          .unique();
        if (reservation && countsTowardCapacity(reservation.status)) {
          await ctx.db.patch(reservation._id, {
            status: "released", releasedAtMs: now, releaseReason: args.reason.slice(0, 100),
          });
        }
        terminated += 1;
      } else {
        await ctx.scheduler.runAfter(0, internal.sandboxActions.terminate, { sandboxOpId: op.appId });
        scheduled += 1;
      }
    }
    if (terminated) await ctx.scheduler.runAfter(0, internal.sandboxes.admitQueued, {});
    return { scheduled, terminated };
  },
});

export const getSandboxOp = internalQuery({
  args: { sandboxOpId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("sandboxOps")
    .withIndex("by_appId", (q) => q.eq("appId", args.sandboxOpId))
    .unique(),
});

export const updateSandboxOp = internalMutation({
  args: {
    sandboxOpId: v.string(),
    status: v.union(
      v.literal("requested"), v.literal("creating"), v.literal("ready"), v.literal("ambiguous_create"),
      v.literal("queued"), v.literal("terminating"), v.literal("ambiguous_terminate"), v.literal("terminated"), v.literal("error"),
    ),
    sandbox: v.optional(v.object({ provider: v.string(), id: v.string() })),
    lastError: v.optional(v.string()),
    terminatedAtMs: v.optional(v.number()),
    releaseReservation: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const op = await ctx.db.query("sandboxOps")
      .withIndex("by_appId", (q) => q.eq("appId", args.sandboxOpId))
      .unique();
    if (!op) throw new ConvexError("sandbox_operation_not_found");
    const now = Date.now();
    await ctx.db.patch(op._id, {
      status: args.status,
      ...(args.sandbox ? { sandbox: args.sandbox } : {}),
      ...(args.lastError ? { lastError: args.lastError } : { lastError: undefined }),
      ...(args.terminatedAtMs ? { terminatedAtMs: args.terminatedAtMs } : {}),
      attempts: op.attempts + (args.status === "creating" || args.status === "terminating" ? 1 : 0),
      updatedAtMs: now,
    });
    {
      const reservation = await ctx.db.query("reservations")
        .withIndex("by_operation", (q) => q.eq("operationId", op.appId))
        .unique();
      if (reservation && args.releaseReservation && countsTowardCapacity(reservation.status)) {
        await ctx.db.patch(reservation._id, {
          status: "released",
          releasedAtMs: now,
          releaseReason: "sandbox_terminated",
        });
        await ctx.scheduler.runAfter(0, internal.sandboxes.admitQueued, {});
      } else if (reservation && ["ambiguous_create", "ambiguous_terminate"].includes(args.status)) {
        await ctx.db.patch(reservation._id, { status: "retained_ambiguous" });
      }
    }
    return { updated: true };
  },
});

export const markBundleReady = internalMutation({
  args: { sandboxOpId: v.string(), bundleSha256: v.string() },
  handler: async (ctx, args) => {
    const op = await ctx.db.query("sandboxOps").withIndex("by_appId", (q) => q.eq("appId", args.sandboxOpId)).unique();
    if (!op) throw new ConvexError("sandbox_operation_not_found");
    await ctx.db.patch(op._id, { bundleSha256: args.bundleSha256, updatedAtMs: Date.now() });
    return { updated: true };
  },
});

export const readyOperationFor = internalQuery({
  args: { investigationId: v.string(), purpose: v.union(v.literal("runner"), v.literal("execution"), v.literal("evaluator"), v.literal("bridge")), environmentId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const ops = await ctx.db.query("sandboxOps").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    return ops.find((op) => op.purpose === args.purpose && (args.environmentId === undefined || op.environmentId === args.environmentId)
      && !["terminated", "terminating", "ambiguous_terminate", "error"].includes(op.status)) ?? null;
  },
});

export const listOperations = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("sandboxOps").collect(),
});

export const markEnvironmentReady = internalMutation({
  args: { environmentId: v.string(), sandbox: v.object({ provider: v.string(), id: v.string() }) },
  handler: async (ctx, args) => {
    const environment = await ctx.db.query("environments")
      .withIndex("by_appId", (q) => q.eq("appId", args.environmentId))
      .unique();
    if (!environment) return { updated: false };
    await ctx.db.patch(environment._id, {
      state: "active",
      daytonaSandbox: args.sandbox,
      startedAtMs: Date.now(),
    });
    return { updated: true };
  },
});
