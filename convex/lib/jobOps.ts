import { ConvexError } from "convex/values";
import { internal } from "../_generated/api.js";
import type { MutationCtx } from "../_generated/server.js";
import { LEASE_EXPIRY_MS } from "./constants.js";
import { validateStageTransition } from "./handoff.js";
import { decideClaim, decideComplete, decideHeartbeat } from "./leasing.js";
import { countsTowardCapacity } from "./reservations.js";

/** Shared job lifecycle operations used by the service-token worker API and
 *  the scoped runner control plane. Every write is fenced on job + attempt +
 *  epoch and idempotent per handoff stage. */

export type HandoffStageName =
  | "admission_reserved" | "grant_installed" | "work_started"
  | "artifacts_persisted" | "evidence_committed" | "completion_acknowledged";

export async function byAppId(ctx: MutationCtx, table: "jobs" | "attempts" | "investigations" | "environments", id: string): Promise<any> {
  return await (ctx.db.query(table) as any).withIndex("by_appId", (q: any) => q.eq("appId", id)).unique();
}

export async function claimJob(ctx: MutationCtx, job: any, workerId: string) {
  const investigation = await byAppId(ctx, "investigations", job.investigationId);
  if (!investigation) throw new ConvexError("investigation_not_found");
  const flags = await ctx.db.query("systemFlags").withIndex("by_key", (q) => q.eq("key", "global")).unique();
  const previousAttempt = job.activeAttemptId ? await byAppId(ctx, "attempts", job.activeAttemptId) : null;
  const dependencies = await Promise.all(job.dependsOn.map((dependencyId: string) => byAppId(ctx, "jobs", dependencyId)));
  if (job.environmentId) {
    const environment = await byAppId(ctx, "environments", job.environmentId);
    if (environment?.state !== "active") throw new ConvexError("dependencies_pending");
  }
  const revoked = new Set<string>();
  if (job.pendingRevocation?.grantId) {
    const grant = await ctx.db.query("grants").withIndex("by_appId", (q) => q.eq("appId", job.pendingRevocation.grantId)).unique();
    if (grant?.spacetimeRevoked || grant?.bridgeMode === "blocked" || grant?.bridgeMode === "fixture") revoked.add(job.pendingRevocation.grantId);
  }
  const decision = decideClaim(
    job, previousAttempt, investigation, { admissionPaused: flags?.admissionPaused ?? false },
    Date.now(), workerId, dependencies.map((dependency: any) => dependency?.state ?? "missing"), revoked,
  );
  if (!decision.ok) throw new ConvexError(decision.reason);
  const now = Date.now();
  const attemptId = decision.job.activeAttemptId;
  await ctx.db.insert("attempts", {
    appId: attemptId, jobId: job.appId, epoch: decision.newEpoch, state: "leased", workerId,
    leasedUntilMs: decision.attempt.leasedUntilMs, lastHeartbeatMs: now, startedAtMs: now,
  });
  await ctx.db.patch(job._id, {
    state: "grant_pending", epoch: decision.newEpoch, activeAttemptId: attemptId,
    attemptsUsed: job.attemptsUsed + 1, leaseExpiresAtMs: decision.job.leaseExpiresAtMs,
    workerId, pendingRevocation: undefined, updatedAtMs: now,
  });
  return { jobId: job.appId, attemptId, operationId: job.operationId, epoch: decision.newEpoch, leaseExpiresAtMs: decision.attempt.leasedUntilMs };
}

export async function heartbeatAttempt(ctx: MutationCtx, job: any, attempt: any, epoch: number, workerId?: string) {
  const investigation = await byAppId(ctx, "investigations", job.investigationId);
  if (!investigation) throw new ConvexError("investigation_not_found");
  const decision = decideHeartbeat(job, attempt, investigation, epoch, Date.now(), workerId);
  if (!decision.ok) return { ok: false as const, reason: decision.reason };
  const now = Date.now();
  await ctx.db.patch(attempt._id, { state: "heartbeating", leasedUntilMs: decision.leasedUntilMs, lastHeartbeatMs: now });
  await ctx.db.patch(job._id, { leaseExpiresAtMs: decision.leasedUntilMs, updatedAtMs: now });
  return { ok: true as const, leasedUntilMs: decision.leasedUntilMs, grantExpiresAtMs: attempt.grantExpiresAtMs ?? decision.grantExtendUntilMs, epoch: attempt.epoch };
}

export async function currentStages(ctx: MutationCtx, job: any, attempt: any) {
  const rows = await ctx.db.query("handoffs").withIndex("by_operation", (q) => q.eq("operationId", job.operationId)).collect();
  return rows.filter((row) => !row.stale && (row.attemptId === attempt.appId || row.stage === "admission_reserved"));
}

const ATTEMPT_LIVE_STATES = new Set(["leased", "heartbeating", "completing"]);

export async function recordStageRow(ctx: MutationCtx, job: any, attempt: any, epoch: number, stage: HandoffStageName, detail: Record<string, unknown> = {}) {
  const stages = await currentStages(ctx, job, attempt);
  if (job.activeAttemptId !== attempt.appId || job.epoch !== epoch || attempt.epoch !== epoch || !ATTEMPT_LIVE_STATES.has(attempt.state) || job.state === "reserved") {
    const duplicate = stages.some((row) => row.attemptId === attempt.appId && row.stage === stage);
    if (!duplicate) {
      await ctx.db.insert("handoffs", {
        operationId: job.operationId, jobId: job.appId, stage, attemptId: attempt.appId,
        detail, atMs: Date.now(), epoch, stale: true,
      });
    }
    return { stale: true as const, stage };
  }
  const transition = validateStageTransition(stages, stage);
  if (transition.result === "duplicate") return { duplicate: true as const, stage };
  if (transition.result === "out_of_order") throw new ConvexError("handoff_out_of_order");
  const now = Date.now();
  await ctx.db.insert("handoffs", {
    operationId: job.operationId, jobId: job.appId, stage, attemptId: attempt.appId,
    ...(typeof detail.grantId === "string" ? { grantId: detail.grantId } : {}),
    detail, atMs: now, epoch, stale: false,
  });
  const jobState = stage === "grant_installed" ? "granted"
    : stage === "work_started" ? "running"
      : stage === "artifacts_persisted" ? "artifacts_pending"
        : stage === "evidence_committed" ? "evidence_pending" : undefined;
  if (jobState) await ctx.db.patch(job._id, { state: jobState, updatedAtMs: now });
  return { duplicate: false as const, stage };
}

export async function completeJob(
  ctx: MutationCtx, job: any, attempt: any, epoch: number,
  outcome: "succeeded" | "failed" | "infra_failed", error?: string,
) {
  const investigation = await byAppId(ctx, "investigations", job.investigationId);
  if (!investigation) throw new ConvexError("investigation_not_found");
  const stages = await currentStages(ctx, job, attempt);
  const decision = decideComplete(job, attempt, investigation, epoch, Date.now(), outcome, stages.map((row) => row.stage));
  if (!decision.ok && decision.reason === "stale_epoch") {
    await ctx.db.patch(attempt._id, { state: "fenced", outcome: "stale_completion_rejected", endedAtMs: Date.now() });
    return { rejected: true as const, reason: decision.reason };
  }
  if (!decision.ok && decision.reason === "expired") {
    return { rejected: true as const, reason: decision.reason };
  }
  if (!decision.ok) throw new ConvexError(decision.reason);
  const now = Date.now();
  await ctx.db.patch(attempt._id, { state: decision.attemptState, outcome, endedAtMs: now });
  const grant = await ctx.db.query("grants").withIndex("by_attempt", (q) => q.eq("attemptId", attempt.appId)).unique();
  if (grant && grant.revokedAtMs === undefined) {
    await ctx.db.patch(grant._id, { revokedAtMs: now, revokeReason: decision.retry ? "attempt_retry" : outcome });
    await ctx.scheduler.runAfter(0, internal.bridge.revokeGrant, { grantId: grant.appId, reason: decision.retry ? "attempt_retry" : outcome });
  }
  if (decision.retry) {
    await ctx.db.patch(job._id, {
      state: "reserved",
      pendingRevocation: {
        attemptId: attempt.appId,
        ...(attempt.grantId ? { grantId: attempt.grantId } : {}),
        epoch: attempt.epoch,
        grantExpiresAtMs: attempt.grantExpiresAtMs ?? now + LEASE_EXPIRY_MS,
      },
      lastError: error ?? outcome,
      updatedAtMs: now,
    });
    return { jobState: "reserved" as const, retry: true as const };
  }
  const transition = validateStageTransition(stages, "completion_acknowledged");
  if (transition.result === "out_of_order") throw new ConvexError("handoff_out_of_order");
  if (transition.result !== "duplicate") {
    await ctx.db.insert("handoffs", {
      operationId: job.operationId, jobId: job.appId, stage: "completion_acknowledged", attemptId: attempt.appId,
      detail: { outcome, ...(error ? { error } : {}) }, atMs: now, epoch, stale: false,
    });
  }
  await ctx.db.patch(job._id, { state: decision.jobState, lastError: outcome === "succeeded" ? undefined : (error ?? outcome), updatedAtMs: now });
  if (decision.jobState !== "succeeded") {
    const reservations = await ctx.db.query("reservations").withIndex("by_operation", (q) => q.eq("operationId", job.operationId)).collect();
    for (const reservation of reservations) {
      if (countsTowardCapacity(reservation.status)) {
        await ctx.db.patch(reservation._id, { status: "released", releasedAtMs: now, releaseReason: outcome });
      }
    }
  }
  if (job.kind === "factory_session") {
    await ctx.scheduler.runAfter(0, internal.investigations.afterEnvironmentJobSettled, { investigationId: job.investigationId });
  }
  return { jobState: decision.jobState, retry: false as const };
}
