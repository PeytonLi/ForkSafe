import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, internalAction } from "./_generated/server.js";
import { decideExpiry } from "./lib/leasing.js";
import { reconcileHandoff } from "./lib/handoff.js";
import { assertUUID } from "./lib/validators.js";
import { finalizeCancelledJob, markAttemptUsageUnknown, releaseAttemptModelTurns } from "./lib/jobOps.js";

// A sandbox op that never produced a sandbox (create failed or was ambiguous and the sweep could not
// find anything to destroy) must not block cancellation from finalizing.
const SETTLED_SANDBOX_STATES = new Set(["queued", "terminated", "error", "ambiguous_create"]);

export const tick = internalMutation({
  args: { now: v.optional(v.number()), scheduleNext: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const activeStates = ["grant_pending", "granted", "running", "artifacts_pending"] as const;
    const jobs = (await Promise.all(activeStates.map((state) =>
      ctx.db.query("jobs").withIndex("by_state", (q) => q.eq("state", state)).take(100),
    ))).flat();
    let expired = 0;
    for (const job of jobs) {
      if (!job.activeAttemptId) continue;
      const attempt = await ctx.db.query("attempts")
        .withIndex("by_appId", (q) => q.eq("appId", job.activeAttemptId!))
        .unique();
      if (!attempt) continue;
      if (job.cancelRequestedAtMs !== undefined && now >= job.cancelRequestedAtMs + 30_000) {
        await finalizeCancelledJob(ctx, job, now);
        expired += 1;
        continue;
      }
      const decision = decideExpiry(job, attempt, now);
      if (!decision.ok) continue;
      await ctx.db.patch(attempt._id, { state: decision.attemptState, endedAtMs: now });
      await releaseAttemptModelTurns(ctx, attempt.appId, now, "attempt_expired");
      await markAttemptUsageUnknown(ctx, attempt.appId, job.environmentId, now);
      await ctx.db.patch(job._id, {
        state: decision.jobState,
        ...(decision.pendingRevocation ? { pendingRevocation: decision.pendingRevocation } : {}),
        updatedAtMs: now,
        ...(decision.retry ? {} : { lastError: "attempts_exhausted" }),
      });
      if (decision.releaseReservations) {
        const reservations = await ctx.db.query("reservations")
          .withIndex("by_operation", (q) => q.eq("operationId", job.operationId))
          .collect();
        for (const reservation of reservations) {
          if (reservation.status === "active" || reservation.status === "retained_ambiguous") {
            await ctx.db.patch(reservation._id, {
              status: "released",
              releasedAtMs: now,
              releaseReason: "attempts_exhausted",
            });
          }
        }
      }
      expired += 1;
    }

    const evidenceJobs = await ctx.db.query("jobs").withIndex("by_state", (q) => q.eq("state", "evidence_pending")).take(100);
    let acknowledged = 0;
    for (const job of evidenceJobs) {
      if (!job.activeAttemptId) continue;
      const attempt = await ctx.db.query("attempts")
        .withIndex("by_appId", (q) => q.eq("appId", job.activeAttemptId!))
        .unique();
      const records = await ctx.db.query("handoffs")
        .withIndex("by_operation", (q) => q.eq("operationId", job.operationId))
        .collect();
      const attemptStages = records.filter((row) =>
        !row.stale && (row.attemptId === attempt?.appId || row.stage === "admission_reserved"),
      );
      const decision = reconcileHandoff({
        job,
        attempt: attempt ? {
          appId: attempt.appId,
          epoch: attempt.epoch,
          leasedUntilMs: attempt.leasedUntilMs,
          startedAtMs: attempt.startedAtMs,
        } : null,
        stages: attemptStages,
        now,
        grantInstallTimeoutMs: 15_000,
      });
      if (decision.action !== "acknowledge_completion") continue;
      const completed = attemptStages.some((row) => row.stage === "completion_acknowledged" && row.attemptId === attempt?.appId);
      if (!completed) {
        await ctx.db.insert("handoffs", {
          operationId: job.operationId,
          jobId: job.appId,
          stage: "completion_acknowledged",
          attemptId: attempt?.appId,
          detail: { evidenceIds: decision.evidenceIds, reconciled: true },
          atMs: now,
          epoch: job.epoch,
          stale: false,
        });
      }
      await ctx.db.patch(job._id, { state: "succeeded", updatedAtMs: now });
      if (attempt && attempt.state !== "succeeded") {
        await ctx.db.patch(attempt._id, { state: "succeeded", outcome: "succeeded", endedAtMs: now });
      }
      acknowledged += 1;
    }
    const activeTurns = await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q) => q.eq("kind", "model_turn").eq("status", "active"))
      .take(100);
    let expiredModelTurns = 0;
    for (const reservation of activeTurns) {
      if (reservation.leasedUntilMs !== undefined && reservation.leasedUntilMs < now) {
        await ctx.db.patch(reservation._id, { status: "expired", releasedAtMs: now, releaseReason: "lease_expired" });
        expiredModelTurns += 1;
      }
    }
    const grantRows = await ctx.db.query("grants").withIndex("by_pending_revoke", (q) => q.eq("spacetimeRevoked", false)).take(100);
    let revocationsScheduled = 0;
    for (const grant of grantRows) {
      const attempt = await ctx.db.query("attempts").withIndex("by_appId", (q) => q.eq("appId", grant.attemptId)).unique();
      const leaseDead = !attempt || ["expired", "fenced", "failed", "succeeded"].includes(attempt.state) || attempt.leasedUntilMs + 30_000 < now;
      if (grant.revokedAtMs === undefined && (leaseDead || grant.expiresAtMs <= now)) {
        await ctx.db.patch(grant._id, { revokedAtMs: now, revokeReason: !attempt ? "attempt_missing" : attempt.state === "succeeded" ? "completed" : "lease_expired" });
      }
      if ((grant.revokedAtMs !== undefined || leaseDead || grant.expiresAtMs <= now) && grant.spacetimeInstalled && revocationsScheduled < 20) {
        await ctx.scheduler.runAfter(0, internal.bridge.revokeGrant, { grantId: grant.appId, reason: grant.revokeReason ?? "lease_expired" });
        revocationsScheduled += 1;
      } else if (!grant.spacetimeInstalled && (grant.revokedAtMs !== undefined || leaseDead)) {
        await ctx.db.patch(grant._id, { spacetimeRevoked: true });
      }
    }
    const cancelling = await ctx.db.query("investigations")
      .withIndex("by_cancel_status", (q) => q.eq("cancelStatus", "cancel_requested"))
      .take(100);
    let finalizedCancellations = 0;
    let terminationScheduled = 0;
    for (const investigation of cancelling) {
      const investigationJobs = await ctx.db.query("jobs")
        .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
        .take(100);
      const operations = await ctx.db.query("sandboxOps")
        .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
        .take(100);
      for (const job of investigationJobs) {
        if (["succeeded", "failed", "cancelled"].includes(job.state)) continue;
        const requestedAt = job.cancelRequestedAtMs ?? now;
        if (job.cancelRequestedAtMs === undefined) {
          await ctx.db.patch(job._id, { cancelRequestedAtMs: now, updatedAtMs: now });
        }
        const attempt = job.activeAttemptId
          ? await ctx.db.query("attempts").withIndex("by_appId", (q) => q.eq("appId", job.activeAttemptId!)).unique()
          : null;
        const hasLiveLease = Boolean(attempt && ["leased", "heartbeating", "completing"].includes(attempt.state)
          && attempt.leasedUntilMs > now && ["grant_pending", "granted", "running", "artifacts_pending"].includes(job.state));
        if (!hasLiveLease || now >= requestedAt + 30_000) {
          await finalizeCancelledJob(ctx, job, now);
          job.state = "cancelled";
        }
      }
      for (const operation of operations) {
        if (operation.status === "queued") {
          await ctx.db.patch(operation._id, {
            status: "terminated", lastError: "cancelled", terminatedAtMs: now, updatedAtMs: now,
          });
        } else if (!["terminated", "terminating"].includes(operation.status) && terminationScheduled < 20) {
          await ctx.scheduler.runAfter(0, internal.sandboxActions.terminate, { sandboxOpId: operation.appId });
          terminationScheduled += 1;
        }
      }
      if (investigationJobs.every((job) => ["succeeded", "failed", "cancelled"].includes(job.state)) &&
          operations.every((operation) => SETTLED_SANDBOX_STATES.has(operation.status) || (operation.status === "ambiguous_terminate" && !operation.sandbox))) {
        await ctx.db.patch(investigation._id, {
          state: "cancelled", cancelStatus: "cancelled", updatedAtMs: now,
        });
        finalizedCancellations += 1;
      }
    }
    await ctx.scheduler.runAfter(0, internal.sandboxes.admitQueued, {});
    if (args.scheduleNext) await ctx.scheduler.runAfter(5_000, internal.reconcile.tick, { scheduleNext: true });
    return { expired, acknowledged, expiredModelTurns, finalizedCancellations, revocationsScheduled, checkedAtMs: now };
  },
});

export const expire = internalMutation({
  args: { jobId: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    assertUUID(args.jobId, "jobId");
    const job = await ctx.db.query("jobs").withIndex("by_appId", (q) => q.eq("appId", args.jobId)).unique();
    if (!job?.activeAttemptId) throw new ConvexError("job_not_active");
    const attempt = await ctx.db.query("attempts")
      .withIndex("by_appId", (q) => q.eq("appId", job.activeAttemptId!))
      .unique();
    if (!attempt) throw new ConvexError("attempt_not_found");
    await ctx.scheduler.runAfter(0, internal.reconcile.tick, { now: args.now ?? Date.now() });
    return { scheduled: true };
  },
});

export const reconcileSandbox = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => await ctx.runAction(internal.sandboxActions.reconcileSandbox, {}),
});
