import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { LEASE_EXPIRY_MS, RUNNER_POOL_LEASE_MS, readLimits } from "./lib/constants.js";
import { byAppId, claimJob, completeJob, currentStages, heartbeatAttempt, recordStageRow } from "./lib/jobOps.js";
import { countsTowardCapacity } from "./lib/reservations.js";
import { issueRunnerCredential } from "./lib/runnerCredentials.js";
import { appId, assertUUID } from "./lib/validators.js";

/** Control plane for trusted runner sandboxes. Each sandbox holds exactly one
 *  scoped, expiring credential bound to one environment; it can only claim,
 *  heartbeat, complete and call tools for jobs of that environment. */

export const issueCredential = internalMutation({
  args: { investigationId: v.string(), environmentId: v.string(), sandboxOpId: v.optional(v.string()) },
  handler: async (ctx, args) => await issueRunnerCredential(ctx, args),
});

export const revokeCredentials = internalMutation({
  args: { investigationId: v.optional(v.string()), environmentId: v.optional(v.string()), reason: v.string() },
  handler: async (ctx, args) => {
    const rows = args.environmentId
      ? await ctx.db.query("runnerCredentials").withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId!)).collect()
      : args.investigationId
        ? await ctx.db.query("runnerCredentials").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId!)).collect()
        : [];
    const now = Date.now();
    let revoked = 0;
    for (const row of rows) {
      if (row.revokedAtMs !== undefined) continue;
      await ctx.db.patch(row._id, { revokedAtMs: now, revokeReason: args.reason });
      revoked += 1;
    }
    return { revoked };
  },
});

export const getCredential = internalQuery({
  args: { credentialId: v.string() },
  handler: async (ctx, args) => {
    if (!/^[0-9a-f-]{36}$/i.test(args.credentialId)) return null;
    return await ctx.db.query("runnerCredentials").withIndex("by_appId", (q) => q.eq("appId", args.credentialId)).unique();
  },
});

async function requireCredential(ctx: any, credentialId: string) {
  const credential = await ctx.db.query("runnerCredentials").withIndex("by_appId", (q: any) => q.eq("appId", credentialId)).unique();
  if (!credential || credential.revokedAtMs !== undefined || credential.expiresAtMs <= Date.now()) throw new ConvexError("unauthorized");
  return credential;
}

/** Claims the next reserved factory_session job for the credential's environment. */
export const claim = internalMutation({
  args: { credentialId: v.string(), workerId: v.string() },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    const now = Date.now();
    await ctx.db.patch(credential._id, { lastSeenAtMs: now, workerId: args.workerId });
    const environment = await byAppId(ctx, "environments", credential.environmentId);
    if (environment?.runnerCredentialId === credential.appId && environment.poolWorkerId === args.workerId) {
      await ctx.db.patch(environment._id, { leasedUntilMs: now + RUNNER_POOL_LEASE_MS });
    }
    const jobs = await ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", credential.investigationId)).collect();
    const candidates = jobs.filter((job) =>
      job.environmentId === credential.environmentId && job.kind === "factory_session" && job.state === "reserved");
    for (const job of candidates.sort((a, b) => a.createdAtMs - b.createdAtMs)) {
      try {
        const claimed = await claimJob(ctx, job, args.workerId);
        const investigation = await byAppId(ctx, "investigations", job.investigationId);
        const environment = await byAppId(ctx, "environments", job.environmentId!);
        const checkpoints = await ctx.db.query("sessionCheckpoints").withIndex("by_environment_job", (q) =>
          q.eq("environmentId", job.environmentId!).eq("jobId", job.appId)).collect();
        const checkpoint = checkpoints.filter((row) => row.role === "primary")
          .sort((a, b) => b.turnIndex - a.turnIndex || b.createdAtMs - a.createdAtMs)[0];
        return {
          claimed,
          job: { ...job, attemptsUsed: job.attemptsUsed + 1, epoch: claimed.epoch, activeAttemptId: claimed.attemptId, state: "grant_pending" },
          investigation, environment, checkpoint,
        };
      } catch (error) {
        if (error instanceof ConvexError) continue;
        throw error;
      }
    }
    return null;
  },
});

async function requireLease(ctx: any, credential: any, attemptId: string, epoch: number, grantId?: string) {
  assertUUID(attemptId, "attemptId");
  const attempt = await byAppId(ctx, "attempts", attemptId);
  if (!attempt) throw new ConvexError("attempt_not_found");
  const job = await byAppId(ctx, "jobs", attempt.jobId);
  if (!job || job.environmentId !== credential.environmentId || job.investigationId !== credential.investigationId) {
    throw new ConvexError("unauthorized");
  }
  if (grantId !== undefined && attempt.grantId !== grantId) throw new ConvexError("fenced");
  if (job.activeAttemptId !== attempt.appId || job.epoch !== epoch || attempt.epoch !== epoch) throw new ConvexError("fenced");
  return { attempt, job };
}

export const heartbeat = internalMutation({
  args: { credentialId: v.string(), attemptId: v.string(), grantId: v.string(), epoch: v.number() },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    let lease;
    try {
      lease = await requireLease(ctx, credential, args.attemptId, args.epoch, args.grantId);
    } catch (error) {
      if (error instanceof ConvexError && error.data === "fenced") return { ok: false as const, reason: "fenced" as const };
      if (error instanceof ConvexError && error.data === "attempt_not_found") return { ok: false as const, reason: "unknown_attempt" as const };
      throw error;
    }
    const grant = await ctx.db.query("grants").withIndex("by_attempt", (q) => q.eq("attemptId", lease.attempt.appId)).unique();
    if (grant?.revokedAtMs !== undefined) return { ok: false as const, reason: "revoked" as const };
    const result = await heartbeatAttempt(ctx, lease.job, lease.attempt, args.epoch);
    if (!result.ok) {
      const reason = result.reason === "cancelled" ? "revoked" : result.reason === "expired" ? "expired" : "fenced";
      return { ok: false as const, reason: reason as "revoked" | "expired" | "fenced" };
    }
    await ctx.db.patch(credential._id, { lastSeenAtMs: Date.now() });
    const environment = await byAppId(ctx, "environments", credential.environmentId);
    if (environment?.runnerCredentialId === credential.appId && environment.poolWorkerId === credential.workerId) {
      await ctx.db.patch(environment._id, { leasedUntilMs: Date.now() + RUNNER_POOL_LEASE_MS });
    }
    const modelTurns = await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q) => q.eq("kind", "model_turn").eq("status", "active"))
      .collect();
    for (const reservation of modelTurns) {
      if (reservation.holder.attemptId === lease.attempt.appId) {
        await ctx.db.patch(reservation._id, { leasedUntilMs: result.leasedUntilMs });
      }
    }
    return result;
  },
});

export const reserveModelTurn = internalMutation({
  args: {
    credentialId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    grantId: v.string(),
    sessionId: v.string(),
    turnKey: v.string(),
  },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    const { attempt, job } = await requireLease(ctx, credential, args.attemptId, args.epoch, args.grantId);
    if (!args.turnKey.startsWith(`${attempt.appId}:${args.sessionId}:`)) throw new ConvexError("turn_key_invalid");
    const session = await ctx.db.query("sessions")
      .withIndex("by_appId", (q) => q.eq("appId", args.sessionId))
      .unique();
    if (!session || session.investigationId !== credential.investigationId
      || session.environmentId !== credential.environmentId || session.attemptId !== attempt.appId) {
      throw new ConvexError("session_mismatch");
    }
    const grant = await ctx.db.query("grants")
      .withIndex("by_appId", (q) => q.eq("appId", args.grantId))
      .unique();
    if (!grant || grant.attemptId !== attempt.appId || grant.revokedAtMs !== undefined || grant.expiresAtMs <= Date.now()) {
      throw new ConvexError("grant_revoked");
    }
    const now = Date.now();
    const existing = await ctx.db.query("reservations")
      .withIndex("by_turn_key", (q) => q.eq("turnKey", args.turnKey))
      .unique();
    if (existing) {
      if (existing.investigationId !== job.investigationId || existing.holder.attemptId !== attempt.appId
        || existing.holder.sessionId !== args.sessionId) throw new ConvexError("turn_key_conflict");
      if (existing.status === "active" && existing.leasedUntilMs !== undefined && existing.leasedUntilMs <= now) {
        await ctx.db.patch(existing._id, {
          status: "expired", releasedAtMs: now, releaseReason: "lease_expired",
        });
        return { granted: false, retryAfterMs: 2_000, reason: "turn_already_released" };
      }
      return countsTowardCapacity(existing.status)
        ? { granted: true, reservationId: existing.appId, leasedUntilMs: existing.leasedUntilMs }
        : { granted: false, retryAfterMs: 2_000, reason: "turn_already_released" };
    }
    const active = await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q) => q.eq("kind", "model_turn").eq("status", "active"))
      .collect();
    for (const reservation of active) {
      if (reservation.leasedUntilMs !== undefined && reservation.leasedUntilMs <= now) {
        await ctx.db.patch(reservation._id, {
          status: "expired", releasedAtMs: now, releaseReason: "lease_expired",
        });
      }
    }
    const stillActive = active.filter((reservation) => reservation.leasedUntilMs === undefined || reservation.leasedUntilMs > now);
    const cap = Math.min(readLimits().maxActiveModelCalls, 4);
    if (stillActive.length >= cap) return { granted: false, retryAfterMs: 2_000, reason: "global_capacity_exhausted" };
    const reservationId = appId();
    const leasedUntilMs = now + LEASE_EXPIRY_MS;
    await ctx.db.insert("reservations", {
      appId: reservationId,
      kind: "model_turn",
      status: "active",
      investigationId: job.investigationId,
      environmentId: credential.environmentId,
      holder: { jobId: job.appId, attemptId: attempt.appId, sessionId: args.sessionId },
      turnKey: args.turnKey,
      operationId: appId(),
      leasedUntilMs,
      createdAtMs: now,
    });
    return { granted: true, reservationId, leasedUntilMs };
  },
});

export const releaseModelTurn = internalMutation({
  args: {
    credentialId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    grantId: v.string(),
    sessionId: v.string(),
    turnKey: v.string(),
  },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    const { attempt } = await requireLease(ctx, credential, args.attemptId, args.epoch, args.grantId);
    const reservation = await ctx.db.query("reservations")
      .withIndex("by_turn_key", (q) => q.eq("turnKey", args.turnKey))
      .unique();
    if (!reservation) return { released: false };
    if (reservation.holder.attemptId !== attempt.appId || reservation.holder.sessionId !== args.sessionId) {
      throw new ConvexError("turn_key_conflict");
    }
    if (!countsTowardCapacity(reservation.status)) return { released: false };
    await ctx.db.patch(reservation._id, {
      status: "released", releasedAtMs: Date.now(), releaseReason: "turn_complete",
    });
    return { released: true };
  },
});

export const recordStage = internalMutation({
  args: {
    credentialId: v.string(), attemptId: v.string(), epoch: v.number(),
    stage: v.union(v.literal("work_started"), v.literal("artifacts_persisted"), v.literal("evidence_committed")),
    detail: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    const { attempt, job } = await requireLease(ctx, credential, args.attemptId, args.epoch);
    return await recordStageRow(ctx, job, attempt, args.epoch, args.stage, args.detail ?? {});
  },
});

const tokenUsage = v.object({
  inputTokens: v.number(), outputTokens: v.number(), cacheReadTokens: v.number(),
  cacheCreationTokens: v.number(), usageKnown: v.boolean(), factoryCredits: v.optional(v.number()),
});
const sessionInput = v.object({
  id: v.string(),
  // The runner posts the full AgentSession projection; ownership is re-derived from the credential.
  investigationId: v.optional(v.string()),
  environmentId: v.optional(v.string()),
  state: v.union(v.literal("created"), v.literal("streaming"), v.literal("idle"), v.literal("budget_exhausted"), v.literal("closed"), v.literal("error")),
  factorySession: v.optional(v.object({ provider: v.string(), id: v.string() })),
  model: v.optional(v.string()),
  mode: v.union(v.literal("live"), v.literal("local"), v.literal("fixture"), v.literal("blocked"), v.literal("not_implemented")),
  tokenUsage,
  turns: v.optional(v.number()),
  unknownTurns: v.optional(v.number()),
  partialTurns: v.optional(v.number()),
  createdAtMs: v.number(),
  closedAtMs: v.optional(v.number()),
});

export const getCompletionAck = internalQuery({
  args: { operationId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("runnerCompletionAcks")
    .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
    .unique(),
});

async function upsertSessionRow(ctx: any, credential: any, attemptId: string, session: any) {
  assertUUID(session.id, "sessionId");
  const existing = await ctx.db.query("sessions").withIndex("by_appId", (q: any) => q.eq("appId", session.id)).unique();
  const now = Date.now();
  const usage = existing ? {
    inputTokens: Math.max(existing.tokenUsage.inputTokens, session.tokenUsage.inputTokens),
    outputTokens: Math.max(existing.tokenUsage.outputTokens, session.tokenUsage.outputTokens),
    cacheReadTokens: Math.max(existing.tokenUsage.cacheReadTokens, session.tokenUsage.cacheReadTokens),
    cacheCreationTokens: Math.max(existing.tokenUsage.cacheCreationTokens, session.tokenUsage.cacheCreationTokens),
    usageKnown: existing.tokenUsage.usageKnown || session.tokenUsage.usageKnown,
    ...(session.tokenUsage.factoryCredits !== undefined
      ? { factoryCredits: Math.max(existing.tokenUsage.factoryCredits ?? 0, session.tokenUsage.factoryCredits) }
      : existing.tokenUsage.factoryCredits !== undefined ? { factoryCredits: existing.tokenUsage.factoryCredits } : {}),
  } : session.tokenUsage;
  const row = {
    appId: session.id, investigationId: credential.investigationId, environmentId: credential.environmentId, attemptId,
    state: session.state, ...(session.factorySession ? { factorySession: session.factorySession } : {}),
    ...(session.model ? { model: session.model } : {}), mode: session.mode, tokenUsage: usage,
    ...(session.turns !== undefined ? { turns: session.turns } : {}),
    ...(session.unknownTurns !== undefined ? { usageUnknownTurns: Math.max(existing?.usageUnknownTurns ?? 0, session.unknownTurns) } : {}),
    ...(session.partialTurns !== undefined ? { usagePartialTurns: Math.max(existing?.usagePartialTurns ?? 0, session.partialTurns) } : {}),
    createdAtMs: session.createdAtMs,
    ...(session.closedAtMs !== undefined ? { closedAtMs: session.closedAtMs } : {}), updatedAtMs: now,
  };
  if (existing) {
    if (existing.environmentId !== credential.environmentId) throw new ConvexError("unauthorized");
    await ctx.db.patch(existing._id, row);
  } else await ctx.db.insert("sessions", row);
}

export const upsertSession = internalMutation({
  args: { credentialId: v.string(), attemptId: v.string(), epoch: v.number(), session: sessionInput },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    await requireLease(ctx, credential, args.attemptId, args.epoch);
    await upsertSessionRow(ctx, credential, args.attemptId, args.session);
    return { ok: true };
  },
});

export const recordUsage = internalMutation({
  args: {
    credentialId: v.string(),
    attemptId: v.string(),
    sessionId: v.string(),
    tokenUsage,
    unknownTurns: v.number(),
    partialTurns: v.number(),
  },
  handler: async (ctx, args) => {
    const credential = await ctx.db.query("runnerCredentials")
      .withIndex("by_appId", (q) => q.eq("appId", args.credentialId))
      .unique();
    if (!credential || (credential.revokedAtMs !== undefined && Date.now() - credential.revokedAtMs > 15 * 60_000)) {
      throw new ConvexError("unauthorized");
    }
    const attempt = await byAppId(ctx, "attempts", args.attemptId);
    const session = await ctx.db.query("sessions")
      .withIndex("by_appId", (q) => q.eq("appId", args.sessionId))
      .unique();
    const job = attempt ? await byAppId(ctx, "jobs", attempt.jobId) : null;
    if (!attempt || !session || !job || job.environmentId !== credential.environmentId
      || job.investigationId !== credential.investigationId || session.attemptId !== attempt.appId
      || session.environmentId !== credential.environmentId || session.investigationId !== credential.investigationId) {
      throw new ConvexError("session_mismatch");
    }
    const prior = session.tokenUsage;
    await ctx.db.patch(session._id, {
      tokenUsage: {
        inputTokens: Math.max(prior.inputTokens, args.tokenUsage.inputTokens),
        outputTokens: Math.max(prior.outputTokens, args.tokenUsage.outputTokens),
        cacheReadTokens: Math.max(prior.cacheReadTokens, args.tokenUsage.cacheReadTokens),
        cacheCreationTokens: Math.max(prior.cacheCreationTokens, args.tokenUsage.cacheCreationTokens),
        usageKnown: prior.usageKnown || args.tokenUsage.usageKnown,
        ...(args.tokenUsage.factoryCredits !== undefined
          ? { factoryCredits: Math.max(prior.factoryCredits ?? 0, args.tokenUsage.factoryCredits) }
          : prior.factoryCredits !== undefined ? { factoryCredits: prior.factoryCredits } : {}),
      },
      usageUnknownTurns: Math.max(session.usageUnknownTurns ?? 0, args.unknownTurns),
      usagePartialTurns: Math.max(session.usagePartialTurns ?? 0, args.partialTurns),
      usageReportedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    return { recorded: true };
  },
});

export const checkpoint = internalMutation({
  args: {
    credentialId: v.string(), attemptId: v.string(), epoch: v.number(),
    checkpoint: v.object({
      investigationId: v.string(), environmentId: v.string(), jobId: v.string(), attemptId: v.string(),
      epoch: v.number(), sessionId: v.string(), vendorSessionId: v.string(), turnIndex: v.number(),
      role: v.union(v.literal("primary"), v.literal("subtask")),
      parentSessionId: v.optional(v.string()), revisionHeadId: v.optional(v.string()), tokenUsage: v.optional(v.any()),
    }),
  },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    const { job } = await requireLease(ctx, credential, args.attemptId, args.epoch);
    const row = args.checkpoint;
    if (row.attemptId !== args.attemptId || row.epoch !== args.epoch || row.jobId !== job.appId
      || row.environmentId !== credential.environmentId || row.investigationId !== credential.investigationId
      || !Number.isInteger(row.turnIndex) || row.turnIndex < 0) throw new ConvexError("checkpoint_invalid");
    const existing = await ctx.db.query("sessionCheckpoints").withIndex("by_session_turn", (q) =>
      q.eq("sessionId", row.sessionId).eq("turnIndex", row.turnIndex)).unique();
    if (existing) return { ok: true, duplicate: true };
    await ctx.db.insert("sessionCheckpoints", { ...row, createdAtMs: Date.now() });
    return { ok: true, duplicate: false };
  },
});

/** artifacts_persisted → evidence_committed → completion_acknowledged in one
 *  transaction; the runner retries with the same operationId if it crashes. */
export const complete = internalMutation({
  args: {
    credentialId: v.string(),
    operationId: v.string(),
    rawBodySha256: v.optional(v.string()),
    attemptId: v.string(),
    grantId: v.string(),
    epoch: v.number(),
    outcome: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("infra_failed")),
    result: v.any(),
    sessions: v.array(sessionInput),
    finishedAtMs: v.number(),
  },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    const existingAck = await ctx.db.query("runnerCompletionAcks")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (existingAck) {
      return existingAck.credentialId === args.credentialId && existingAck.rawBodySha256 === (args.rawBodySha256 ?? "")
        ? existingAck.response
        : { accepted: false, reason: "operation_conflict" };
    }
    const saveAck = async (response: any) => {
      await ctx.db.insert("runnerCompletionAcks", {
        operationId: args.operationId,
        credentialId: args.credentialId,
        attemptId: args.attemptId,
        rawBodySha256: args.rawBodySha256 ?? "",
        response,
        createdAtMs: Date.now(),
      });
      return response;
    };
    const { attempt, job } = await requireLease(ctx, credential, args.attemptId, args.epoch, args.grantId).catch((error) => {
      if (error instanceof ConvexError && error.data === "fenced") return { attempt: null, job: null };
      throw error;
    });
    if (!attempt || !job) return await saveAck({ accepted: false, reason: "fenced" });
    for (const session of args.sessions) {
      await upsertSessionRow(ctx, credential, attempt.appId, session);
      const row = await ctx.db.query("sessions").withIndex("by_appId", (q) => q.eq("appId", session.id)).unique();
      if (row) await ctx.db.patch(row._id, { usageReportedAtMs: Date.now() });
    }
    const summary = {
      operationId: args.operationId,
      sessions: args.sessions.map((session) => ({ id: session.id, factorySession: session.factorySession, usage: session.tokenUsage })),
      result: args.result,
      finishedAtMs: args.finishedAtMs,
    };
    const stages = ["artifacts_persisted", "evidence_committed"] as const;
    for (const stage of stages) {
      if (stage === "artifacts_persisted") {
        const stages = await currentStages(ctx, job, attempt);
        if (!stages.some((row) => row.stage === "work_started")) {
          const started = await recordStageRow(ctx, job, attempt, args.epoch, "work_started", { implied: true, runnerOperationId: args.operationId });
          if ("stale" in started) return await saveAck({ accepted: false, reason: "stale_epoch" });
        }
      }
      const stageResult = await recordStageRow(ctx, job, attempt, args.epoch, stage, { runnerOperationId: args.operationId, ...(stage === "evidence_committed" ? { evidenceIds: args.sessions.map((session) => session.id) } : {}) });
      if ("stale" in stageResult) return await saveAck({ accepted: false, reason: "fenced" });
      if (job.state !== "artifacts_pending" && job.state !== "evidence_pending") {
        job.state = stage === "artifacts_persisted" ? "artifacts_pending" : "evidence_pending";
      }
    }
    const refreshedJob = await byAppId(ctx, "jobs", job.appId);
    const refreshedAttempt = await byAppId(ctx, "attempts", attempt.appId);
    const completion = await completeJob(ctx, refreshedJob, refreshedAttempt, args.epoch, args.outcome,
      typeof args.result?.error === "string" ? String(args.result.error).slice(0, 200) : undefined);
    if ("rejected" in completion) return await saveAck({ accepted: false, reason: completion.reason });
    void summary;
    return await saveAck({ accepted: true, jobState: completion.jobState, retry: completion.retry });
  },
});

/** Fence check for every tool call. Returns the records the tool needs. */
export const authorizeTool = internalQuery({
  args: {
    credentialId: v.string(), attemptId: v.string(), grantId: v.string(), epoch: v.number(),
    investigationId: v.string(), environmentId: v.string(), sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    const credential = await ctx.db.query("runnerCredentials").withIndex("by_appId", (q) => q.eq("appId", args.credentialId)).unique();
    if (!credential || credential.revokedAtMs !== undefined || credential.expiresAtMs <= Date.now()) throw new ConvexError("unauthorized");
    if (credential.environmentId !== args.environmentId || credential.investigationId !== args.investigationId) throw new ConvexError("unauthorized");
    const attempt = await ctx.db.query("attempts").withIndex("by_appId", (q) => q.eq("appId", args.attemptId)).unique();
    const job = attempt ? await ctx.db.query("jobs").withIndex("by_appId", (q) => q.eq("appId", attempt.jobId)).unique() : null;
    if (!attempt || !job || job.environmentId !== credential.environmentId) throw new ConvexError("fenced");
    if (job.activeAttemptId !== attempt.appId || job.epoch !== args.epoch || attempt.epoch !== args.epoch) throw new ConvexError("fenced");
    if (attempt.leasedUntilMs <= Date.now()) throw new ConvexError("lease_expired");
    const grant = await ctx.db.query("grants").withIndex("by_attempt", (q) => q.eq("attemptId", attempt.appId)).unique();
    if (!grant || grant.appId !== args.grantId || grant.revokedAtMs !== undefined || grant.expiresAtMs <= Date.now()) throw new ConvexError("grant_revoked");
    if (grant.jobId !== job.appId || grant.epoch !== args.epoch || grant.investigationId !== job.investigationId
      || grant.environmentId !== job.environmentId) throw new ConvexError("fenced");
    const session = await ctx.db.query("sessions").withIndex("by_appId", (q) => q.eq("appId", args.sessionId)).unique();
    if (!session || session.investigationId !== job.investigationId || session.environmentId !== job.environmentId
      || session.attemptId !== attempt.appId) throw new ConvexError("session_mismatch");
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", job.investigationId)).unique();
    if (!investigation || investigation.cancelStatus !== "none" || job.cancelRequestedAtMs !== undefined) throw new ConvexError("investigation_cancelling");
    const environment = await ctx.db.query("environments").withIndex("by_appId", (q) => q.eq("appId", job.environmentId!)).unique();
    if (!environment || environment.state !== "active") throw new ConvexError("environment_inactive");
    return { job, attempt, grant, investigation, environment };
  },
});

export const markGrantInstalled = internalMutation({
  args: { credentialId: v.string(), attemptId: v.string(), epoch: v.number(), grantId: v.string(), bridgeMode: v.string() },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    const { attempt, job } = await requireLease(ctx, credential, args.attemptId, args.epoch);
    const stage = await recordStageRow(ctx, job, attempt, args.epoch, "grant_installed", { grantId: args.grantId, bridgeMode: args.bridgeMode });
    // Claim + bridge install already burned part of the original lease. Refresh so
    // the runner still has a full window to open Factory before the first heartbeat.
    const now = Date.now();
    const leasedUntilMs = now + LEASE_EXPIRY_MS;
    await ctx.db.patch(attempt._id, { leasedUntilMs, lastHeartbeatMs: now });
    await ctx.db.patch(job._id, { leaseExpiresAtMs: leasedUntilMs, updatedAtMs: now });
    return { ...stage, leasedUntilMs };
  },
});

/** Grant install failed against a live bridge: give the lease back (one infra retry). */
export const failGrantInstall = internalMutation({
  args: { credentialId: v.string(), attemptId: v.string(), epoch: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const credential = await requireCredential(ctx, args.credentialId);
    const { attempt, job } = await requireLease(ctx, credential, args.attemptId, args.epoch);
    return await completeJob(ctx, job, attempt, args.epoch, "infra_failed", args.error.slice(0, 120));
  },
});
