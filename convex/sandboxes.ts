import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { readLimits } from "./lib/constants.js";
import { decideReserve, countsTowardCapacity } from "./lib/reservations.js";
import { appId, assertUUID } from "./lib/validators.js";

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
    const reservation = decideReserve("sandbox", active.length + ambiguous.length, limits.maxActiveSandboxes);
    if (!reservation.ok) throw new ConvexError(reservation.reason);
    const operationId = appId();
    const reservationId = appId();
    const now = Date.now();
    await ctx.db.insert("reservations", {
      appId: reservationId,
      kind: "sandbox",
      status: "active",
      investigationId: args.investigationId,
      holder: {
        ...(args.jobId ? { jobId: args.jobId } : {}),
        ...(args.attemptId ? { attemptId: args.attemptId } : {}),
        sandboxOpId: operationId,
      },
      environmentId: args.environmentId,
      operationId,
      createdAtMs: now,
    });
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
      status: "requested",
      reservationId,
      attempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });
    if (args.provider === "local" || process.env.DAYTONA_MODE === "local") {
      const provisionJobId = appId();
      await ctx.db.insert("jobs", {
        appId: provisionJobId,
        kind: "provision_sandbox",
        state: "reserved",
        investigationId: args.investigationId,
        ...(args.environmentId ? { environmentId: args.environmentId } : {}),
        epoch: 0,
        idempotencyKey: `${operationId}:provision`,
        payload: { sandboxOpId: operationId },
        attemptsUsed: 0,
        maxAttempts: 2,
        operationId: appId(),
        admittedCancelEpoch: 0,
        dependsOn: [],
        createdAtMs: now,
        updatedAtMs: now,
      });
      await ctx.db.patch(sandboxOpDbId, { jobId: provisionJobId });
      return { sandboxOpId: operationId, localWorkerRequired: true, jobId: provisionJobId };
    }
    await ctx.scheduler.runAfter(0, internal.daytonaPool.enqueueProvision, { sandboxOpId: operationId });
    return { sandboxOpId: operationId, localWorkerRequired: false };
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
      v.literal("terminating"), v.literal("ambiguous_terminate"), v.literal("terminated"), v.literal("error"),
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
      } else if (reservation && ["ambiguous_create", "ambiguous_terminate"].includes(args.status)) {
        await ctx.db.patch(reservation._id, { status: "retained_ambiguous" });
      }
    }
    return { updated: true };
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
