import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { RUNNER_CREDENTIAL_TTL_MS } from "./lib/constants.js";
import { byAppId, claimJob, completeJob, currentStages, heartbeatAttempt, recordStageRow } from "./lib/jobOps.js";
import { randomSecret } from "./lib/runnerAuth.js";
import { appId, assertUUID } from "./lib/validators.js";

/** Control plane for trusted runner sandboxes. Each sandbox holds exactly one
 *  scoped, expiring credential bound to one environment; it can only claim,
 *  heartbeat, complete and call tools for jobs of that environment. */

export const issueCredential = internalMutation({
  args: { investigationId: v.string(), environmentId: v.string(), sandboxOpId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    assertUUID(args.investigationId, "investigationId");
    assertUUID(args.environmentId, "environmentId");
    const now = Date.now();
    const previous = await ctx.db.query("runnerCredentials").withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId)).collect();
    for (const row of previous) {
      if (row.revokedAtMs === undefined) await ctx.db.patch(row._id, { revokedAtMs: now, revokeReason: "superseded" });
    }
    const credentialId = appId();
    const secret = randomSecret();
    const expiresAtMs = now + RUNNER_CREDENTIAL_TTL_MS;
    await ctx.db.insert("runnerCredentials", {
      appId: credentialId, investigationId: args.investigationId, environmentId: args.environmentId,
      ...(args.sandboxOpId ? { sandboxOpId: args.sandboxOpId } : {}),
      secret, expiresAtMs, createdAtMs: now,
    });
    const environment = await byAppId(ctx, "environments", args.environmentId);
    if (environment) await ctx.db.patch(environment._id, { runnerCredentialId: credentialId });
    return { credentialId, secret, expiresAtMs };
  },
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
    await ctx.db.patch(credential._id, { lastSeenAtMs: Date.now(), workerId: args.workerId });
    const jobs = await ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", credential.investigationId)).collect();
    const candidates = jobs.filter((job) =>
      job.environmentId === credential.environmentId && job.kind === "factory_session" && job.state === "reserved");
    for (const job of candidates.sort((a, b) => a.createdAtMs - b.createdAtMs)) {
      try {
        const claimed = await claimJob(ctx, job, args.workerId);
        const investigation = await byAppId(ctx, "investigations", job.investigationId);
        const environment = await byAppId(ctx, "environments", job.environmentId!);
        return { claimed, job: { ...job, epoch: claimed.epoch, activeAttemptId: claimed.attemptId, state: "grant_pending" }, investigation, environment };
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
    return result;
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
  createdAtMs: v.number(),
  closedAtMs: v.optional(v.number()),
});

async function upsertSessionRow(ctx: any, credential: any, attemptId: string, session: any) {
  assertUUID(session.id, "sessionId");
  const existing = await ctx.db.query("sessions").withIndex("by_appId", (q: any) => q.eq("appId", session.id)).unique();
  const now = Date.now();
  const row = {
    appId: session.id, investigationId: credential.investigationId, environmentId: credential.environmentId, attemptId,
    state: session.state, ...(session.factorySession ? { factorySession: session.factorySession } : {}),
    ...(session.model ? { model: session.model } : {}), mode: session.mode, tokenUsage: session.tokenUsage,
    ...(session.turns !== undefined ? { turns: session.turns } : {}), createdAtMs: session.createdAtMs,
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

/** artifacts_persisted → evidence_committed → completion_acknowledged in one
 *  transaction; the runner retries with the same operationId if it crashes. */
export const complete = internalMutation({
  args: {
    credentialId: v.string(),
    operationId: v.string(),
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
    const { attempt, job } = await requireLease(ctx, credential, args.attemptId, args.epoch, args.grantId).catch((error) => {
      if (error instanceof ConvexError && error.data === "fenced") return { attempt: null, job: null };
      throw error;
    });
    if (!attempt || !job) return { accepted: false, reason: "fenced" };
    for (const session of args.sessions) await upsertSessionRow(ctx, credential, attempt.appId, session);
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
          if ("stale" in started) return { accepted: false, reason: "stale_epoch" };
        }
      }
      const stageResult = await recordStageRow(ctx, job, attempt, args.epoch, stage, { runnerOperationId: args.operationId, ...(stage === "evidence_committed" ? { evidenceIds: args.sessions.map((session) => session.id) } : {}) });
      if ("stale" in stageResult) return { accepted: false, reason: "fenced" };
      if (job.state !== "artifacts_pending" && job.state !== "evidence_pending") {
        job.state = stage === "artifacts_persisted" ? "artifacts_pending" : "evidence_pending";
      }
    }
    const refreshedJob = await byAppId(ctx, "jobs", job.appId);
    const refreshedAttempt = await byAppId(ctx, "attempts", attempt.appId);
    const completion = await completeJob(ctx, refreshedJob, refreshedAttempt, args.epoch, args.outcome,
      typeof args.result?.error === "string" ? String(args.result.error).slice(0, 200) : undefined);
    if ("rejected" in completion) return { accepted: false, reason: completion.reason };
    void summary;
    return { accepted: true, jobState: completion.jobState, retry: completion.retry };
  },
});

/** Fence check for every tool call. Returns the records the tool needs. */
export const authorizeTool = internalQuery({
  args: { credentialId: v.string(), attemptId: v.string(), grantId: v.string(), epoch: v.number(), investigationId: v.string(), environmentId: v.string() },
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
    return await recordStageRow(ctx, job, attempt, args.epoch, "grant_installed", { grantId: args.grantId, bridgeMode: args.bridgeMode });
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
