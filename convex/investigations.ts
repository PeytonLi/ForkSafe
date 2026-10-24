import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api.js";
import { mutation, query, internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import { readLimits } from "./lib/constants.js";
import { countsTowardCapacity } from "./lib/reservations.js";
import { requireServiceToken, requireUiAccess } from "./lib/auth.js";
import { appId, assertUUID } from "./lib/validators.js";

const simCase = v.object({
  caseId: v.string(),
  suite: v.union(v.literal("original"), v.literal("public"), v.literal("withheld")),
  seed: v.number(),
  sceneOverrides: v.record(v.string(), v.number()),
  description: v.optional(v.string()),
});

export const create = mutation({
  args: {
    title: v.string(),
    requestedEnvironments: v.optional(v.number()),
    baselineCase: v.optional(simCase),
    baselineExperimentId: v.optional(v.string()),
    jiraIssueKey: v.optional(v.string()),
    idempotencyKey: v.string(),
    serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    const existing = await ctx.db.query("investigations")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing) return { investigationId: existing.appId, duplicate: true };
    const limits = readLimits();
    const requestedEnvironments = args.requestedEnvironments ?? limits.defaultEnvironments;
    if (!args.title.trim()) throw new ConvexError("title_required");
    if (!Number.isInteger(requestedEnvironments) || requestedEnvironments < 1 || requestedEnvironments > limits.maxEnvironments) {
      throw new ConvexError("requestedEnvironments_out_of_range");
    }
    if (args.idempotencyKey.length < 8) throw new ConvexError("idempotencyKey_too_short");
    const now = Date.now();
    const investigationId = appId();
    const baselineCase = args.baselineCase ?? {
      caseId: appId(),
      suite: "original" as const,
      seed: 1,
      sceneOverrides: {},
    };
    if (args.baselineExperimentId) assertUUID(args.baselineExperimentId, "baselineExperimentId");
    await ctx.db.insert("investigations", {
      appId: investigationId,
      title: args.title.trim(),
      state: "capturing",
      cancelStatus: "none",
      cancelEpoch: 0,
      version: 1,
      requestedEnvironments,
      baselineCase,
      baselineExperimentId: args.baselineExperimentId ?? appId(),
      ...(args.jiraIssueKey ? { jiraIssueKey: args.jiraIssueKey } : {}),
      budget: {
        wallTimeMs: 600_000,
        maxExperimentsPerEnv: 20,
        maxCandidatesPerEnv: 2,
        maxFinalCandidates: 3,
      },
      idempotencyKey: args.idempotencyKey,
      createdAtMs: now,
      updatedAtMs: now,
    });
    return { investigationId, duplicate: false };
  },
});

async function startHandler(ctx: MutationCtx, args: { investigationId: string; expectedVersion: number }) {
    assertUUID(args.investigationId, "investigationId");
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation) throw new ConvexError("investigation_not_found");
    if (investigation.state === "admitted" || investigation.state === "searching") {
      return { investigationId: investigation.appId, duplicate: true };
    }
    if (investigation.version !== args.expectedVersion) throw new ConvexError("version_conflict");
    if (investigation.state !== "capturing") throw new ConvexError("investigation_not_startable");
    const flag = await ctx.db.query("systemFlags").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (flag?.admissionPaused) throw new ConvexError("admission_paused");
    const now = Date.now();
    const jobIds: string[] = [];
    for (let index = 0; index < investigation.requestedEnvironments; index += 1) {
      const environmentId = appId();
      const jobId = appId();
      jobIds.push(jobId);
      const operationId = appId();
      await ctx.db.insert("environments", {
        appId: environmentId,
        investigationId: investigation.appId,
        index,
        state: "provisioning",
        budgets: {
          maxExperiments: investigation.budget.maxExperimentsPerEnv,
          maxCandidates: investigation.budget.maxCandidatesPerEnv,
          maxFactorySessions: 2,
          wallTimeMs: investigation.budget.wallTimeMs,
        },
        experimentsUsed: 0,
        candidatesUsed: 0,
      });
      await ctx.db.insert("jobs", {
        appId: jobId,
        kind: "factory_session",
        state: "reserved",
        investigationId: investigation.appId,
        environmentId,
        epoch: 0,
        idempotencyKey: `${investigation.appId}:factory:${index}`,
        payload: { environmentIndex: index },
        attemptsUsed: 0,
        maxAttempts: 2,
        operationId,
        admittedCancelEpoch: investigation.cancelEpoch,
        dependsOn: [],
        createdAtMs: now,
        updatedAtMs: now,
      });
      await ctx.db.insert("reservations", {
        appId: appId(),
        kind: "environment_job",
        status: "active",
        investigationId: investigation.appId,
        holder: { jobId },
        operationId,
        createdAtMs: now,
      });
      await ctx.db.insert("handoffs", {
        operationId,
        jobId,
        stage: "admission_reserved",
        detail: { environmentId },
        atMs: now,
        epoch: 0,
        stale: false,
      });
    }
    await ctx.db.patch(investigation._id, {
      state: "searching",
      version: investigation.version + 1,
      startedAtMs: now,
      updatedAtMs: now,
    });
    await ctx.scheduler.runAfter(0, internal.workflows.launch, { investigationId: investigation.appId });
    return { investigationId: investigation.appId, duplicate: false, jobIds };
}

export const start = mutation({
  args: { investigationId: v.string(), expectedVersion: v.number(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    return await startHandler(ctx, args);
  },
});

export const startAdmitted = internalMutation({
  args: { investigationId: v.string(), expectedVersion: v.number() },
  handler: async (ctx, args) => await startHandler(ctx, args),
});

export const enterEvaluation = internalMutation({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ scheduled: boolean; duplicate?: boolean }> => {
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation || investigation.state !== "searching") return { scheduled: false };
    const jobs = await ctx.db.query("jobs")
      .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
      .collect();
    const factoryJobs = jobs.filter((job) => job.kind === "factory_session");
    if (!factoryJobs.length || factoryJobs.some((job) => job.state !== "succeeded")) return { scheduled: false };
    if (jobs.some((job) => job.kind === "evaluate_candidate")) return { scheduled: false, duplicate: true };
    const environmentId = appId();
    const jobId = appId();
    const operationId = appId();
    const now = Date.now();
    await ctx.db.insert("environments", {
      appId: environmentId,
      investigationId: investigation.appId,
      index: factoryJobs.length,
      state: "provisioning",
      budgets: {
        maxExperiments: investigation.budget.maxExperimentsPerEnv,
        maxCandidates: investigation.budget.maxCandidatesPerEnv,
        maxFactorySessions: 1,
        wallTimeMs: investigation.budget.wallTimeMs,
      },
      experimentsUsed: 0,
      candidatesUsed: 0,
    });
    await ctx.db.insert("jobs", {
      appId: jobId,
      kind: "evaluate_candidate",
      state: "reserved",
      investigationId: investigation.appId,
      environmentId,
      epoch: 0,
      idempotencyKey: `${investigation.appId}:evaluate_candidate`,
      payload: { purpose: "evaluator" },
      attemptsUsed: 0,
      maxAttempts: 2,
      operationId,
      admittedCancelEpoch: investigation.cancelEpoch,
      dependsOn: [],
      createdAtMs: now,
      updatedAtMs: now,
    });
    await ctx.db.insert("reservations", {
      appId: appId(),
      kind: "environment_job",
      status: "active",
      investigationId: investigation.appId,
      environmentId,
      holder: { jobId },
      operationId,
      createdAtMs: now,
    });
    await ctx.db.patch(investigation._id, {
      state: "evaluating",
      version: investigation.version + 1,
      updatedAtMs: now,
    });
    const provider = process.env.DAYTONA_MODE === "local" ? "local" : "daytona";
    await ctx.scheduler.runAfter(0, internal.sandboxes.requestSandbox, {
      purpose: "evaluator",
      investigationId: investigation.appId,
      environmentId,
      jobId,
      snapshot: process.env.DAYTONA_EXECUTION_SNAPSHOT ?? "forksafe-exec-v1",
      resources: { cpu: 2, memoryGiB: 2, diskGiB: 10 },
      provider,
    });
    return { scheduled: true };
  },
});

export const get = query({
  args: { investigationId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    return await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
  },
});

export const attachWorkflowId = internalMutation({
  args: { investigationId: v.string(), workflowId: v.string() },
  handler: async (ctx, args) => {
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation) throw new ConvexError("investigation_not_found");
    await ctx.db.patch(investigation._id, {
      workflowId: args.workflowId,
      updatedAtMs: Date.now(),
      version: investigation.version + 1,
    });
  },
});

export const cancel = mutation({
  args: { investigationId: v.string(), expectedVersion: v.optional(v.number()), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation) throw new ConvexError("investigation not found");
    if (args.expectedVersion !== undefined && investigation.version !== args.expectedVersion) throw new ConvexError("version_conflict");
    if (["completed", "cancelled", "failed"].includes(investigation.state)) {
      return { investigationId: investigation.appId, duplicate: true };
    }
    const now = Date.now();
    const cancelEpoch = investigation.cancelEpoch + 1;
    await ctx.db.patch(investigation._id, {
      cancelStatus: "cancel_requested",
      cancelEpoch,
      version: investigation.version + 1,
      updatedAtMs: now,
    });
    const jobs = await ctx.db.query("jobs")
      .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
      .collect();
    for (const job of jobs) {
      if (["succeeded", "failed", "cancelled"].includes(job.state)) continue;
      if (!job.activeAttemptId) {
        await ctx.db.patch(job._id, { state: "cancelled", cancelRequestedAtMs: now, updatedAtMs: now });
        const reservations = await ctx.db.query("reservations")
          .withIndex("by_operation", (q) => q.eq("operationId", job.operationId))
          .collect();
        for (const reservation of reservations) {
          if (countsTowardCapacity(reservation.status) && reservation.kind !== "sandbox") {
            await ctx.db.patch(reservation._id, { status: "released", releasedAtMs: now, releaseReason: "cancelled" });
          }
        }
      } else {
        await ctx.db.patch(job._id, { cancelRequestedAtMs: now, updatedAtMs: now });
      }
    }
    const sandboxOps = await ctx.db.query("sandboxOps")
      .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
      .collect();
    for (const op of sandboxOps) {
      if (op.status !== "terminated") await ctx.scheduler.runAfter(0, internal.sandboxActions.terminate, { sandboxOpId: op.appId });
    }
    await ctx.scheduler.runAfter(0, internal.runnerControl.revokeCredentials, { investigationId: investigation.appId, reason: "cancelled" });
    const grants = await ctx.db.query("grants").withIndex("by_pending_revoke", (q) => q.eq("spacetimeRevoked", false)).take(200);
    for (const grant of grants) {
      if (grant.investigationId !== investigation.appId) continue;
      if (grant.revokedAtMs === undefined) await ctx.db.patch(grant._id, { revokedAtMs: now, revokeReason: "cancelled" });
      await ctx.scheduler.runAfter(0, internal.bridge.revokeGrant, { grantId: grant.appId, reason: "cancelled" });
    }
    return { investigationId: investigation.appId, duplicate: false };
  },
});

/** Called whenever a factory_session job settles. Once every environment job
 *  is terminal the investigation either enters protected evaluation or fails
 *  closed when no candidate was submitted. */
export const afterEnvironmentJobSettled = internalMutation({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ action: string }> => {
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique();
    if (!investigation || investigation.state !== "searching" || investigation.cancelStatus !== "none") return { action: "none" };
    const jobs = await ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId)).collect();
    const envJobs = jobs.filter((job) => job.kind === "factory_session");
    if (!envJobs.length || envJobs.some((job) => !["succeeded", "failed", "cancelled"].includes(job.state))) return { action: "waiting" };
    const candidates = await ctx.db.query("candidates").withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId)).collect();
    const now = Date.now();
    const environments = await ctx.db.query("environments").withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId)).collect();
    for (const environment of environments) {
      if (environment.state === "active" || environment.state === "provisioning") await ctx.db.patch(environment._id, { state: "closing" });
    }
    await ctx.scheduler.runAfter(0, internal.evaluation.closeEnvironments, { investigationId: investigation.appId });
    if (!candidates.length) {
      await ctx.db.patch(investigation._id, { state: "failed", lastError: "no_candidates_submitted", version: investigation.version + 1, updatedAtMs: now, finishedAtMs: now });
      return { action: "failed_no_candidates" };
    }
    await ctx.db.patch(investigation._id, { state: "evaluating", version: investigation.version + 1, updatedAtMs: now });
    await ctx.scheduler.runAfter(0, internal.evaluation.start, { investigationId: investigation.appId });
    return { action: "evaluating" };
  },
});

function toInvestigation(row: any) {
  return {
    id: row.appId, state: row.state, title: row.title, baselineCase: row.baselineCase, baselineExperimentId: row.baselineExperimentId,
    ...(row.jiraIssueKey ? { jiraIssueKey: row.jiraIssueKey } : {}), requestedEnvironments: row.requestedEnvironments,
    createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs,
  };
}

/** Web: `investigations:list`, newest first. */
export const list = query({
  args: { serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    const rows = await ctx.db.query("investigations").order("desc").take(100);
    return rows.map((row) => ({ id: row.appId, title: row.title, state: row.state, requestedEnvironments: row.requestedEnvironments, updatedAtMs: row.updatedAtMs }));
  },
});

const sha64 = (value: string) => /^[0-9a-f]{64}$/i.test(value) ? value : "0".repeat(64);

/** Web: `investigations:workspace` — lifecycle plus the bridge projection. */
export const workspace = query({
  args: { investigationId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique();
    if (!investigation) throw new ConvexError("investigation not found");
    const id = investigation.appId;
    const [environments, sessions, experiments, candidates, evaluations, reviews] = await Promise.all([
      ctx.db.query("environments").withIndex("by_investigation", (q) => q.eq("investigationId", id)).collect(),
      ctx.db.query("sessions").withIndex("by_investigation", (q) => q.eq("investigationId", id)).collect(),
      ctx.db.query("experiments").withIndex("by_investigation", (q) => q.eq("investigationId", id)).collect(),
      ctx.db.query("candidates").withIndex("by_investigation", (q) => q.eq("investigationId", id)).collect(),
      ctx.db.query("evaluations").withIndex("by_investigation", (q) => q.eq("investigationId", id)).collect(),
      ctx.db.query("reviews").withIndex("by_investigation", (q) => q.eq("investigationId", id)).collect(),
    ]);
    return {
      investigation: toInvestigation(investigation),
      environments: environments.sort((a, b) => a.index - b.index).map((row) => ({
        id: row.appId, investigationId: id, index: row.index, state: row.state,
        ...(row.daytonaSandbox ? { daytonaSandbox: row.daytonaSandbox } : {}), budgets: row.budgets,
        ...(row.startedAtMs !== undefined ? { startedAtMs: row.startedAtMs } : {}), ...(row.closedAtMs !== undefined ? { closedAtMs: row.closedAtMs } : {}),
      })),
      sessions: sessions.map((row) => ({
        id: row.appId, investigationId: id, environmentId: row.environmentId, state: row.state,
        ...(row.factorySession ? { factorySession: row.factorySession } : {}), ...(row.model ? { model: row.model } : {}),
        mode: row.mode, tokenUsage: row.tokenUsage, createdAtMs: row.createdAtMs, ...(row.closedAtMs !== undefined ? { closedAtMs: row.closedAtMs } : {}),
      })),
      experiments: experiments.filter((row) => row.suite !== "withheld").map((row) => ({
        id: row.appId, investigationId: id, ...(row.environmentId ? { environmentId: row.environmentId } : {}),
        ...(row.candidateId ? { candidateId: row.candidateId } : {}), attemptId: row.attemptId, epoch: row.epoch, simCase: row.simCase,
        status: row.status, failureKinds: row.failureKinds, completed: row.completed,
        ...(row.completionTimeSec !== undefined ? { completionTimeSec: row.completionTimeSec } : {}), changedFunctions: row.changedFunctions,
        ...(row.traceArtifactId ? { traceArtifactId: row.traceArtifactId } : {}), ...(row.replayArtifactId ? { replayArtifactId: row.replayArtifactId } : {}),
        engineVersion: row.engineVersion, assetsSha256: sha64(row.assetsSha256), controllerSha256: sha64(row.controllerSha256),
        startedAtMs: row.startedAtMs, ...(row.finishedAtMs !== undefined ? { finishedAtMs: row.finishedAtMs } : {}),
      })),
      candidates: candidates.map((row) => ({
        id: row.appId, investigationId: id, environmentId: row.environmentId, status: row.status, controllerSha256: row.controllerSha256,
        sourceArtifactId: row.sourceArtifactId, changedFunctions: row.changedFunctions, ...(row.rationale ? { rationale: row.rationale } : {}),
        basedOnFindings: row.basedOnFindings, submittedByAttemptId: row.submittedByAttemptId, submittedAtMs: row.submittedAtMs,
      })),
      evaluations: evaluations.map((row) => ({
        id: row.appId, candidateId: row.candidateId, investigationId: id, evaluatorAttemptId: row.evaluatorAttemptId, suite: row.suite,
        cases: row.cases.map((item) => ({ caseId: item.caseId, status: item.status, ...(item.experimentId ? { experimentId: item.experimentId } : {}),
          ...(item.completionTimeSec !== undefined ? { completionTimeSec: item.completionTimeSec } : {}), failureKinds: item.failureKinds })),
        allRequiredPassed: row.allRequiredPassed, ...(row.medianCompletionTimeSec !== undefined ? { medianCompletionTimeSec: row.medianCompletionTimeSec } : {}),
        status: row.status, ...(row.reportArtifactId ? { reportArtifactId: row.reportArtifactId } : {}), createdAtMs: row.createdAtMs,
      })),
      reviews: reviews.map((row) => ({
        id: row.appId, investigationId: id, candidateId: row.candidateId, evaluationId: row.evaluationId, controllerSha256: row.controllerSha256,
        decision: row.decision, reviewerIdentity: row.reviewerIdentity, ...(row.notes ? { notes: row.notes } : {}),
        ...(row.jiraIssueKey ? { jiraIssueKey: row.jiraIssueKey } : {}), createdAtMs: row.createdAtMs,
      })),
      cancellation: investigation.cancelStatus === "none" ? "none" : investigation.cancelStatus === "cancel_requested" ? "requested" : "confirmed",
      asOfMs: Date.now(),
    };
  },
});

/** Web: `investigations:capture`. Records a real baseline failure run in an
 *  execution sandbox before the investigation can start. */
export const capture = mutation({
  args: {
    title: v.string(), seed: v.number(), sceneOverrides: v.record(v.string(), v.number()), requestedEnvironments: v.number(),
    autoStart: v.optional(v.boolean()), idempotencyKey: v.optional(v.string()), serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ accepted: true; investigationId: string } | { accepted: false; mode: string; reason: string }> => {
    requireServiceToken(args.serviceToken);
    const limits = readLimits();
    if (!args.title.trim()) return { accepted: false, mode: "live", reason: "title is required" };
    if (!Number.isInteger(args.seed) || args.seed < 0) return { accepted: false, mode: "live", reason: "seed must be a non-negative integer" };
    if (!Number.isInteger(args.requestedEnvironments) || args.requestedEnvironments < 1 || args.requestedEnvironments > limits.maxEnvironments) {
      return { accepted: false, mode: "live", reason: `requestedEnvironments must be 1-${limits.maxEnvironments}` };
    }
    for (const [key, value] of Object.entries(args.sceneOverrides)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) || !Number.isFinite(value)) return { accepted: false, mode: "live", reason: `invalid scene override ${key}` };
    }
    if (process.env.DAYTONA_MODE !== "cloud" || !process.env.DAYTONA_API_KEY) {
      return { accepted: false, mode: process.env.DAYTONA_MODE === "local" ? "local" : "blocked", reason: "capture needs a Daytona execution sandbox; DAYTONA_API_KEY is not configured" };
    }
    const bundle = await ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", "simulator")).unique();
    const baseline = await ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", "baseline_controller")).unique();
    if (!bundle || !baseline) return { accepted: false, mode: "blocked", reason: "simulator bundle not published (run apps/runner publish-bundles)" };
    const idempotencyKey = args.idempotencyKey ?? appId();
    const existing = await ctx.db.query("investigations").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", idempotencyKey)).unique();
    if (existing) return { accepted: true, investigationId: existing.appId };
    const now = Date.now();
    const investigationId = appId();
    const baselineExperimentId = appId();
    await ctx.db.insert("investigations", {
      appId: investigationId, title: args.title.trim().slice(0, 200), state: "capturing", cancelStatus: "none", cancelEpoch: 0, version: 1,
      requestedEnvironments: args.requestedEnvironments,
      baselineCase: { caseId: "original-divider-collision", suite: "original", seed: args.seed, sceneOverrides: args.sceneOverrides, description: "Captured baseline failure" },
      baselineExperimentId,
      budget: { wallTimeMs: 600_000, maxExperimentsPerEnv: 20, maxCandidatesPerEnv: 2, maxFinalCandidates: 3 },
      idempotencyKey, captureStatus: "pending", autoStart: args.autoStart ?? true, createdAtMs: now, updatedAtMs: now,
    });
    await ctx.scheduler.runAfter(0, internal.capture.run, { investigationId });
    return { accepted: true, investigationId };
  },
});

export const getByAppId = internalQuery({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique(),
});

export const setCapture = internalMutation({
  args: { investigationId: v.string(), captureStatus: v.union(v.literal("running"), v.literal("recorded"), v.literal("failed")), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique();
    if (!investigation) throw new ConvexError("investigation_not_found");
    const now = Date.now();
    await ctx.db.patch(investigation._id, {
      captureStatus: args.captureStatus, updatedAtMs: now, version: investigation.version + 1,
      // A late/duplicate "recorded" must not pull an already-started investigation back to admitted.
      ...(args.captureStatus === "recorded" && ["created", "capturing", "admitted"].includes(investigation.state) ? { state: "admitted" as const } : {}),
      ...(args.captureStatus === "failed" ? { state: "failed" as const, lastError: args.error ?? "capture_failed", finishedAtMs: now } : {}),
    });
    return { version: investigation.version + 1, autoStart: investigation.autoStart ?? false };
  },
});

/** Internal start used after capture (same admission path as `start`). */
export const startInternal = internalMutation({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => {
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique();
    if (!investigation) throw new ConvexError("investigation_not_found");
    if (investigation.state !== "admitted" && investigation.state !== "capturing") return { duplicate: true };
    await ctx.db.patch(investigation._id, { state: "capturing" });
    return await startHandler(ctx, { investigationId: investigation.appId, expectedVersion: investigation.version });
  },
});
