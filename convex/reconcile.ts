import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, internalAction } from "./_generated/server.js";
import { decideExpiry } from "./lib/leasing.js";
import { reconcileHandoff } from "./lib/handoff.js";
import { assertUUID } from "./lib/validators.js";

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
        await ctx.db.patch(attempt._id, { state: "expired", endedAtMs: now });
        await ctx.db.patch(job._id, { state: "cancelled", updatedAtMs: now });
        const reservations = await ctx.db.query("reservations")
          .withIndex("by_operation", (q) => q.eq("operationId", job.operationId))
          .collect();
        for (const reservation of reservations) {
          if (reservation.kind !== "sandbox" && reservation.status === "active") {
            await ctx.db.patch(reservation._id, {
              status: "released", releasedAtMs: now, releaseReason: "cancelled",
            });
          }
        }
        const sandboxOps = await ctx.db.query("sandboxOps")
          .withIndex("by_investigation", (q) => q.eq("investigationId", job.investigationId))
          .take(100);
        for (const op of sandboxOps) {
          if (op.status !== "terminated") {
            await ctx.scheduler.runAfter(0, internal.sandboxActions.terminate, { sandboxOpId: op.appId });
          }
        }
        expired += 1;
        continue;
      }
      const decision = decideExpiry(job, attempt, now);
      if (!decision.ok) continue;
      await ctx.db.patch(attempt._id, { state: decision.attemptState, endedAtMs: now });
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
    const cancelling = await ctx.db.query("investigations")
      .withIndex("by_cancel_status", (q) => q.eq("cancelStatus", "cancel_requested"))
      .take(100);
    let finalizedCancellations = 0;
    for (const investigation of cancelling) {
      const investigationJobs = await ctx.db.query("jobs")
        .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
        .take(100);
      const operations = await ctx.db.query("sandboxOps")
        .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
        .take(100);
      if (investigationJobs.every((job) => ["succeeded", "failed", "cancelled"].includes(job.state)) &&
          operations.every((operation) => operation.status === "terminated")) {
        await ctx.db.patch(investigation._id, {
          state: "cancelled", cancelStatus: "cancelled", updatedAtMs: now,
        });
        finalizedCancellations += 1;
      }
    }
    if (args.scheduleNext) await ctx.scheduler.runAfter(5_000, internal.reconcile.tick, { scheduleNext: true });
    return { expired, acknowledged, expiredModelTurns, finalizedCancellations, checkedAtMs: now };
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
