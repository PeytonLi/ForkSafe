import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { mutation, internalMutation, query } from "./_generated/server.js";
import { requireServiceToken } from "./lib/auth.js";
import { readLimits, HEARTBEAT_INTERVAL_MS, LEASE_EXPIRY_MS } from "./lib/constants.js";
import { decideClaim, decideComplete, decideHeartbeat } from "./lib/leasing.js";
import { validateStageTransition } from "./lib/handoff.js";
import { decideModelTurnReserve, decideReserve, countsTowardCapacity } from "./lib/reservations.js";
import { appId, assertUUID } from "./lib/validators.js";

const handoffStage = v.union(
  v.literal("admission_reserved"), v.literal("grant_installed"), v.literal("work_started"),
  v.literal("artifacts_persisted"), v.literal("evidence_committed"), v.literal("completion_acknowledged"),
);

async function findByAppId(ctx: any, table: string, id: string): Promise<any> {
  return await ctx.db.query(table).withIndex("by_appId", (q: any) => q.eq("appId", id)).unique();
}

export const claim = mutation({
  args: { jobId: v.string(), workerId: v.string(), serviceToken: v.string() },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.jobId, "jobId");
    if (!args.workerId.trim()) throw new ConvexError("workerId_required");
    const job = await findByAppId(ctx, "jobs", args.jobId);
    if (!job) throw new ConvexError("job_not_found");
    const investigation = await findByAppId(ctx, "investigations", job.investigationId);
    if (!investigation) throw new ConvexError("investigation_not_found");
    const flags = await ctx.db.query("systemFlags").withIndex("by_key", (q: any) => q.eq("key", "global")).unique();
    const previousAttempt = job.activeAttemptId
      ? await findByAppId(ctx, "attempts", job.activeAttemptId)
      : null;
    const dependencies = await Promise.all(job.dependsOn.map((dependencyId: string) => findByAppId(ctx, "jobs", dependencyId)));
    if (job.environmentId) {
      const environment = await findByAppId(ctx, "environments", job.environmentId);
      if (environment?.state !== "active") throw new ConvexError("dependencies_pending");
    }
    const decision = decideClaim(
      job,
      previousAttempt,
      investigation,
      { admissionPaused: flags?.admissionPaused ?? false },
      Date.now(),
      args.workerId,
      dependencies.map((dependency: any) => dependency?.state ?? "missing"),
    );
    if (!decision.ok) throw new ConvexError(decision.reason);
    const now = Date.now();
    const attemptId = decision.job.activeAttemptId;
    await ctx.db.insert("attempts", {
      appId: attemptId,
      jobId: job.appId,
      epoch: decision.newEpoch,
      state: "leased",
      workerId: args.workerId,
      leasedUntilMs: decision.attempt.leasedUntilMs,
      lastHeartbeatMs: now,
      startedAtMs: now,
    });
    await ctx.db.patch(job._id, {
      state: "grant_pending",
      epoch: decision.newEpoch,
      activeAttemptId: attemptId,
      attemptsUsed: job.attemptsUsed + 1,
      leaseExpiresAtMs: decision.job.leaseExpiresAtMs,
      workerId: args.workerId,
      pendingRevocation: undefined,
      updatedAtMs: now,
    });
    return {
      jobId: job.appId,
      attemptId,
      operationId: job.operationId,
      epoch: decision.newEpoch,
      leaseExpiresAtMs: decision.attempt.leasedUntilMs,
    };
  },
});

export const heartbeat = mutation({
  args: {
    jobId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    workerId: v.string(),
    serviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.jobId, "jobId");
    assertUUID(args.attemptId, "attemptId");
    const job = await findByAppId(ctx, "jobs", args.jobId);
    const attempt = await findByAppId(ctx, "attempts", args.attemptId);
    if (!job || !attempt || attempt.jobId !== job.appId) throw new ConvexError("attempt_not_found");
    const investigation = await findByAppId(ctx, "investigations", job.investigationId);
    if (!investigation) throw new ConvexError("investigation_not_found");
    const decision = decideHeartbeat(job, attempt, investigation, args.epoch, Date.now(), args.workerId);
    if (!decision.ok && decision.reason === "cancelled") return { stop: true, reason: decision.reason };
    if (!decision.ok) throw new ConvexError(decision.reason);
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      state: "heartbeating",
      leasedUntilMs: decision.leasedUntilMs,
      lastHeartbeatMs: now,
      grantExpiresAtMs: decision.grantExtendUntilMs,
    });
    await ctx.db.patch(job._id, { leaseExpiresAtMs: decision.leasedUntilMs, updatedAtMs: now });
    return {
      leasedUntilMs: decision.leasedUntilMs,
      nextHeartbeatInMs: HEARTBEAT_INTERVAL_MS,
      grantExpiresAtMs: decision.grantExtendUntilMs,
    };
  },
});

export const recordStage = mutation({
  args: {
    jobId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    stage: handoffStage,
    detail: v.optional(v.any()),
    serviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.jobId, "jobId");
    assertUUID(args.attemptId, "attemptId");
    const job = await findByAppId(ctx, "jobs", args.jobId);
    const attempt = await findByAppId(ctx, "attempts", args.attemptId);
    if (!job || !attempt || attempt.jobId !== job.appId) throw new ConvexError("attempt_not_found");
    const rows = await ctx.db.query("handoffs")
      .withIndex("by_operation", (q: any) => q.eq("operationId", job.operationId))
      .collect();
    const stages = rows.filter((row: any) =>
      (row.attemptId === attempt.appId || row.stage === "admission_reserved") && !row.stale,
    );
    if (job.activeAttemptId !== attempt.appId || job.epoch !== args.epoch || attempt.epoch !== args.epoch) {
      const duplicate = stages.some((row: any) => row.attemptId === attempt.appId && row.stage === args.stage);
      if (!duplicate) {
        await ctx.db.insert("handoffs", {
          operationId: job.operationId,
          jobId: job.appId,
          stage: args.stage,
          attemptId: attempt.appId,
          detail: args.detail ?? {},
          atMs: Date.now(),
          epoch: args.epoch,
          stale: true,
        });
      }
      return { stale: true, stage: args.stage };
    }
    const transition = validateStageTransition(stages, args.stage);
    if (transition.result === "duplicate") return { duplicate: true, stage: args.stage };
    if (transition.result === "out_of_order") throw new ConvexError("handoff_out_of_order");
    const now = Date.now();
    await ctx.db.insert("handoffs", {
      operationId: job.operationId,
      jobId: job.appId,
      stage: args.stage,
      attemptId: attempt.appId,
      ...(args.detail?.grantId ? { grantId: args.detail.grantId } : {}),
      detail: args.detail ?? {},
      atMs: now,
      epoch: args.epoch,
      stale: false,
    });
    if (args.stage === "grant_installed") await ctx.db.patch(job._id, { state: "granted", updatedAtMs: now });
    else if (args.stage === "work_started") await ctx.db.patch(job._id, { state: "running", updatedAtMs: now });
    else if (args.stage === "artifacts_persisted") await ctx.db.patch(job._id, { state: "artifacts_pending", updatedAtMs: now });
    else if (args.stage === "evidence_committed") await ctx.db.patch(job._id, { state: "evidence_pending", updatedAtMs: now });
    return { duplicate: false, stage: args.stage };
  },
});

export const complete = mutation({
  args: {
    jobId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    outcome: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("infra_failed")),
    serviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.jobId, "jobId");
    assertUUID(args.attemptId, "attemptId");
    const job = await findByAppId(ctx, "jobs", args.jobId);
    const attempt = await findByAppId(ctx, "attempts", args.attemptId);
    if (!job || !attempt || attempt.jobId !== job.appId) throw new ConvexError("attempt_not_found");
    const investigation = await findByAppId(ctx, "investigations", job.investigationId);
    if (!investigation) throw new ConvexError("investigation_not_found");
    const rows = await ctx.db.query("handoffs")
      .withIndex("by_operation", (q: any) => q.eq("operationId", job.operationId))
      .collect();
    const currentStages = rows.filter((row: any) =>
      !row.stale && (row.attemptId === attempt.appId || row.stage === "admission_reserved"),
    );
    const decision = decideComplete(job, attempt, investigation, args.epoch, Date.now(), args.outcome, currentStages.map((row: any) => row.stage));
    if (!decision.ok && decision.reason === "stale_epoch") {
      await ctx.db.patch(attempt._id, { state: "fenced", outcome: "stale_completion_rejected", endedAtMs: Date.now() });
      return { rejected: true, reason: decision.reason };
    }
    if (!decision.ok) throw new ConvexError(decision.reason);
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      state: decision.attemptState,
      outcome: args.outcome,
      endedAtMs: now,
    });
    if (decision.retry) {
      await ctx.db.patch(job._id, {
        state: "reserved",
        pendingRevocation: {
          attemptId: attempt.appId,
          ...(attempt.grantId ? { grantId: attempt.grantId } : {}),
          epoch: attempt.epoch,
          grantExpiresAtMs: attempt.grantExpiresAtMs ?? now + LEASE_EXPIRY_MS,
        },
        updatedAtMs: now,
      });
      return { jobState: "reserved", retry: true };
    }
    const transition = validateStageTransition(currentStages, "completion_acknowledged");
    if (transition.result === "out_of_order") throw new ConvexError("handoff_out_of_order");
    if (transition.result !== "duplicate") {
      await ctx.db.insert("handoffs", {
        operationId: job.operationId,
        jobId: job.appId,
        stage: "completion_acknowledged",
        attemptId: attempt.appId,
        detail: { outcome: args.outcome },
        atMs: now,
        epoch: args.epoch,
        stale: false,
      });
    }
    await ctx.db.patch(job._id, {
      state: decision.jobState,
      lastError: args.outcome === "succeeded" ? undefined : args.outcome,
      updatedAtMs: now,
    });
    if (job.state !== "succeeded") {
      const reservations = await ctx.db.query("reservations")
        .withIndex("by_operation", (q: any) => q.eq("operationId", job.operationId))
        .collect();
      for (const reservation of reservations) {
        if (countsTowardCapacity(reservation.status)) {
          await ctx.db.patch(reservation._id, { status: "released", releasedAtMs: now, releaseReason: args.outcome });
        }
      }
    }
    if (decision.jobState === "succeeded" && job.kind === "factory_session") {
      const siblings = await ctx.db.query("jobs")
        .withIndex("by_investigation", (q: any) => q.eq("investigationId", job.investigationId))
        .collect();
      if (siblings.filter((item: any) => item.kind === "factory_session").every((item: any) => item.state === "succeeded")) {
        await ctx.scheduler.runAfter(0, internal.investigations.enterEvaluation, { investigationId: job.investigationId });
      }
    }
    return { jobState: decision.jobState, retry: false };
  },
});

export const reserveModelTurn = mutation({
  args: {
    investigationId: v.string(),
    sessionId: v.string(),
    environmentId: v.string(),
    jobId: v.optional(v.string()),
    serviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const limits = readLimits();
    assertUUID(args.environmentId, "environmentId");
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q: any) => q.eq("kind", "model_turn").eq("status", "active"))
      .collect();
    const activeForSession = reservations.filter((row: any) => row.holder.sessionId === args.sessionId).length;
    const decision = decideModelTurnReserve(reservations.length, activeForSession, limits.maxActiveModelCalls, 1);
    if (!decision.ok) throw new ConvexError(decision.reason);
    const now = Date.now();
    const operationId = appId();
    const reservationId = appId();
    await ctx.db.insert("reservations", {
      appId: reservationId,
      kind: "model_turn",
      status: "active",
      investigationId: args.investigationId,
      holder: { sessionId: args.sessionId, ...(args.jobId ? { jobId: args.jobId } : {}) },
      environmentId: args.environmentId,
      operationId,
      leasedUntilMs: now + LEASE_EXPIRY_MS,
      createdAtMs: now,
    });
    return { reservationId, operationId };
  },
});

export const releaseReservation = mutation({
  args: { reservationId: v.string(), reason: v.string(), serviceToken: v.string() },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.reservationId, "reservationId");
    const reservation = await findByAppId(ctx, "reservations", args.reservationId);
    if (!reservation) throw new ConvexError("reservation_not_found");
    if (!countsTowardCapacity(reservation.status)) return { released: false };
    await ctx.db.patch(reservation._id, {
      status: "released",
      releasedAtMs: Date.now(),
      releaseReason: args.reason,
    });
    return { released: true };
  },
});

export const releaseModelTurn = releaseReservation;

export const acknowledgeGrantRevocation = internalMutation({
  args: { jobId: v.string(), attemptId: v.string(), epoch: v.number() },
  handler: async (ctx, args) => {
    const job = await findByAppId(ctx, "jobs", args.jobId);
    if (!job || job.pendingRevocation?.attemptId !== args.attemptId || job.pendingRevocation.epoch !== args.epoch) {
      return { acknowledged: false };
    }
    const attempt = await findByAppId(ctx, "attempts", args.attemptId);
    if (attempt) await ctx.db.patch(attempt._id, { grantRevokedAtMs: Date.now() });
    await ctx.db.patch(job._id, { pendingRevocation: undefined, updatedAtMs: Date.now() });
    return { acknowledged: true };
  },
});

export const getJob = query({
  args: { jobId: v.string(), serviceToken: v.string() },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.jobId, "jobId");
    return await findByAppId(ctx, "jobs", args.jobId);
  },
});

export const registerLocalArtifact = internalMutation({
  args: {
    investigationId: v.string(),
    kind: v.union(
      v.literal("trace"), v.literal("replay"), v.literal("controller_source"),
      v.literal("log"), v.literal("report"), v.literal("screenshot"),
    ),
    sha256: v.string(),
    bytes: v.number(),
    storageKey: v.string(),
    producedByAttemptId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertUUID(args.investigationId, "investigationId");
    if (args.bytes < 0 || args.bytes > 8 * 1024 * 1024) throw new ConvexError("artifact_chunk_size_invalid");
    if (!/^[0-9a-f]{64}$/i.test(args.sha256)) throw new ConvexError("sha256_invalid");
    const appArtifactId = appId();
    const now = Date.now();
    await ctx.db.insert("artifacts", {
      appId: appArtifactId,
      kind: args.kind,
      sha256: args.sha256,
      bytes: args.bytes,
      storage: "local_fs",
      storageKey: args.storageKey,
      ...(args.producedByAttemptId ? { producedByAttemptId: args.producedByAttemptId } : {}),
      createdAtMs: now,
      investigationId: args.investigationId,
      visibility: "internal",
    });
    return { artifactId: appArtifactId };
  },
});
