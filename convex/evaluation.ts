import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import publicManifest from "../evaluation/public/manifest.json";
import withheldManifest from "../evaluation/withheld/manifest.json";
import { MAX_FINALISTS } from "./lib/constants.js";
import { caseStatus, classifyExperiment, median, rankCandidates } from "./lib/experimentStatus.js";
import { loadTrustedKeys, verifySignedEvaluation } from "./lib/signedEvaluation.js";
import { byAppId, claimJob, completeJob, heartbeatAttempt, recordStageRow } from "./lib/jobOps.js";
import { appId } from "./lib/validators.js";
import { evaluatorBackend } from "./lib/evaluatorBackend.js";

/** Protected evaluator. Each candidate is evaluated in a FRESH execution
 *  sandbox that never held agent session state; the evaluator attempt is a
 *  Convex-owned lease with its own environment-independent grant. Withheld
 *  cases never leave this module: agents only ever see case ids. */

type ManifestCase = { caseId: string; suite: "public" | "withheld"; seed: number; sceneOverrides: Record<string, number>; description?: string };
const suites: Record<"public" | "withheld", ManifestCase[]> = {
  public: (publicManifest as { cases: ManifestCase[] }).cases,
  withheld: (withheldManifest as { cases: ManifestCase[] }).cases,
};
const EVALUATOR_WORKER = "convex-evaluator";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const start = internalMutation({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => {
    const investigation = await byAppId(ctx, "investigations", args.investigationId);
    if (!investigation || investigation.state !== "evaluating") return { scheduled: false };
    const candidates = await ctx.db.query("candidates").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    const jobs = await ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    const now = Date.now();
    let created = 0;
    for (const candidate of candidates) {
      const idempotencyKey = `${args.investigationId}:evaluate:${candidate.appId}:public`;
      if (jobs.some((job) => job.idempotencyKey === idempotencyKey)) continue;
      const operationId = appId();
      const jobId = appId();
      await ctx.db.insert("jobs", {
        appId: jobId, kind: "evaluate_candidate", state: "reserved", investigationId: args.investigationId, epoch: 0,
        idempotencyKey, payload: { candidateId: candidate.appId, suite: "public" }, attemptsUsed: 0, maxAttempts: 2, operationId,
        admittedCancelEpoch: investigation.cancelEpoch, dependsOn: [], createdAtMs: now, updatedAtMs: now,
      });
      await ctx.db.insert("handoffs", { operationId, jobId, stage: "admission_reserved", detail: { candidateId: candidate.appId, suite: "public" }, atMs: now, epoch: 0, stale: false });
      await ctx.db.patch(candidate._id, { status: "evaluating", updatedAtMs: now });
      created += 1;
    }
    await ctx.scheduler.runAfter(0, internal.evaluation.evaluateNext, { investigationId: args.investigationId });
    return { scheduled: true, created };
  },
});

/** Runner sandboxes and credentials are torn down once the search phase ends;
 *  the evaluator never reuses them. */
export const closeEnvironments = internalMutation({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => {
    const ops = await ctx.db.query("sandboxOps").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    for (const op of ops) {
      if ((op.purpose === "runner" || op.purpose === "execution") && !["terminated", "terminating"].includes(op.status)) {
        if (op.status === "queued") {
          await ctx.db.patch(op._id, {
            status: "terminated", lastError: "search_complete",
            terminatedAtMs: Date.now(), updatedAtMs: Date.now(),
          });
        } else {
          await ctx.scheduler.runAfter(0, internal.sandboxActions.terminate, { sandboxOpId: op.appId });
        }
      }
    }
    await ctx.scheduler.runAfter(0, internal.sandboxes.admitQueued, {});
    await ctx.scheduler.runAfter(0, internal.runnerControl.revokeCredentials, { investigationId: args.investigationId, reason: "search_complete" });
    const environments = await ctx.db.query("environments").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    const now = Date.now();
    for (const environment of environments) {
      if (environment.state !== "closed" && environment.state !== "error") await ctx.db.patch(environment._id, { state: "closed", closedAtMs: now });
    }
    return { closed: environments.length };
  },
});

export const nextJob = internalQuery({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => {
    const jobs = await ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    const evaluate = jobs.filter((job) => job.kind === "evaluate_candidate");
    return {
      next: evaluate.find((job) => job.state === "reserved") ?? null,
      active: evaluate.some((job) => !["reserved", "succeeded", "failed", "cancelled"].includes(job.state)),
      allTerminal: evaluate.length > 0 && evaluate.every((job) => ["succeeded", "failed", "cancelled"].includes(job.state)),
      jobs: evaluate,
    };
  },
});

export const claimEvaluation = internalMutation({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const job = await byAppId(ctx, "jobs", args.jobId);
    if (!job) throw new ConvexError("job_not_found");
    const claimed = await claimJob(ctx, job, EVALUATOR_WORKER);
    const candidate = await ctx.db.query("candidates").withIndex("by_appId", (q) => q.eq("appId", job.payload.candidateId)).unique();
    const source = candidate ? await ctx.db.query("controllerSources").withIndex("by_sha", (q) => q.eq("controllerSha256", candidate.controllerSha256)).unique() : null;
    return { claimed, job, candidate, source: source?.source ?? null };
  },
});

export const heartbeatEvaluation = internalMutation({
  args: { jobId: v.string(), attemptId: v.string(), epoch: v.number() },
  handler: async (ctx, args) => {
    const job = await byAppId(ctx, "jobs", args.jobId);
    const attempt = await byAppId(ctx, "attempts", args.attemptId);
    if (!job || !attempt) return { ok: false, reason: "unknown_attempt" };
    return await heartbeatAttempt(ctx, job, attempt, args.epoch, EVALUATOR_WORKER);
  },
});

export const stageEvaluation = internalMutation({
  args: { jobId: v.string(), attemptId: v.string(), epoch: v.number(), stage: v.union(v.literal("grant_installed"), v.literal("work_started"), v.literal("artifacts_persisted"), v.literal("evidence_committed")), detail: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const job = await byAppId(ctx, "jobs", args.jobId);
    const attempt = await byAppId(ctx, "attempts", args.attemptId);
    if (!job || !attempt) throw new ConvexError("attempt_not_found");
    return await recordStageRow(ctx, job, attempt, args.epoch, args.stage, args.detail ?? {});
  },
});

export const completeEvaluation = internalMutation({
  args: { jobId: v.string(), attemptId: v.string(), epoch: v.number(), outcome: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("infra_failed")), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const job = await byAppId(ctx, "jobs", args.jobId);
    const attempt = await byAppId(ctx, "attempts", args.attemptId);
    if (!job || !attempt) throw new ConvexError("attempt_not_found");
    return await completeJob(ctx, job, attempt, args.epoch, args.outcome, args.error);
  },
});

export const insertEvaluation = internalMutation({
  args: {
    evaluationId: v.string(), candidateId: v.string(), investigationId: v.string(), evaluatorAttemptId: v.string(), jobId: v.string(), epoch: v.number(),
    grantId: v.optional(v.string()), suite: v.union(v.literal("public"), v.literal("withheld")),
    cases: v.array(v.object({ caseId: v.string(), status: v.union(v.literal("passed"), v.literal("failed"), v.literal("invalid")), experimentId: v.optional(v.string()), completionTimeSec: v.optional(v.number()), failureKinds: v.array(v.string()) })),
    allRequiredPassed: v.boolean(), medianCompletionTimeSec: v.optional(v.number()), status: v.union(v.literal("passed"), v.literal("failed"), v.literal("invalid")), sandboxOpId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("evaluations").withIndex("by_appId", (q) => q.eq("appId", args.evaluationId)).unique();
    if (existing) return { duplicate: true };
    const now = Date.now();
    const { evaluationId, ...rest } = args;
    await ctx.db.insert("evaluations", { appId: evaluationId, ...rest, spacetimeCommitted: false, createdAtMs: now, updatedAtMs: now });
    return { duplicate: false };
  },
});

/** Picks finalists after the public round, then closes out once withheld
 *  evaluations exist for every finalist. */
export const advance = internalMutation({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ action: string }> => {
    const investigation = await byAppId(ctx, "investigations", args.investigationId);
    if (!investigation || investigation.state !== "evaluating") return { action: "none" };
    const jobs = (await ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect())
      .filter((job) => job.kind === "evaluate_candidate");
    if (jobs.some((job) => !["succeeded", "failed", "cancelled"].includes(job.state))) return { action: "waiting" };
    const evaluations = await ctx.db.query("evaluations").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    const candidates = await ctx.db.query("candidates").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    const now = Date.now();
    const withheldJobs = jobs.filter((job) => job.payload?.suite === "withheld");
    if (!withheldJobs.length) {
      const ranked = rankCandidates(candidates.map((candidate) => {
        const evaluation = evaluations.find((row) => row.candidateId === candidate.appId && row.suite === "public");
        return { id: candidate.appId, allPassed: evaluation?.allRequiredPassed ?? false, changedFunctions: candidate.changedFunctions.length, medianCompletionTimeSec: evaluation?.medianCompletionTimeSec, hasEvaluation: Boolean(evaluation) };
      }).filter((item) => item.hasEvaluation));
      const finalists = ranked.slice(0, Math.min(MAX_FINALISTS, investigation.budget.maxFinalCandidates));
      for (const [index, candidate] of candidates.entries()) {
        const rank = ranked.findIndex((item) => item.id === candidate.appId);
        const finalist = finalists.some((item) => item.id === candidate.appId);
        await ctx.db.patch(candidate._id, { finalist, ...(rank >= 0 ? { rank: rank + 1 } : {}), status: finalist ? "evaluating" : "evaluated", updatedAtMs: now + index });
      }
      if (!finalists.length) {
        await ctx.db.patch(investigation._id, { state: "awaiting_review", version: investigation.version + 1, updatedAtMs: now });
        await scheduleReviewIssue(ctx, args.investigationId);
        return { action: "awaiting_review_no_finalists" };
      }
      for (const finalist of finalists) {
        const operationId = appId();
        const jobId = appId();
        await ctx.db.insert("jobs", {
          appId: jobId, kind: "evaluate_candidate", state: "reserved", investigationId: args.investigationId, epoch: 0,
          idempotencyKey: `${args.investigationId}:evaluate:${finalist.id}:withheld`, payload: { candidateId: finalist.id, suite: "withheld" },
          attemptsUsed: 0, maxAttempts: 2, operationId, admittedCancelEpoch: investigation.cancelEpoch, dependsOn: [], createdAtMs: now, updatedAtMs: now,
        });
        await ctx.db.insert("handoffs", { operationId, jobId, stage: "admission_reserved", detail: { candidateId: finalist.id, suite: "withheld" }, atMs: now, epoch: 0, stale: false });
      }
      await ctx.scheduler.runAfter(0, internal.evaluation.evaluateNext, { investigationId: args.investigationId });
      return { action: "withheld_scheduled" };
    }
    for (const candidate of candidates) {
      if (candidate.status === "evaluating") await ctx.db.patch(candidate._id, { status: "evaluated", updatedAtMs: now });
    }
    await ctx.db.patch(investigation._id, { state: "awaiting_review", version: investigation.version + 1, updatedAtMs: now });
    await scheduleReviewIssue(ctx, args.investigationId);
    return { action: "awaiting_review" };
  },
});

async function freshEvaluatorSandbox(ctx: any, investigationId: string, jobId: string, attemptId: string) {
  const provider = process.env.DAYTONA_MODE === "local" ? "local" : "daytona";
  const requested = await ctx.runMutation(internal.sandboxes.requestSandbox, {
    purpose: "evaluator", investigationId, jobId, attemptId, snapshot: process.env.DAYTONA_EXECUTION_SNAPSHOT ?? "forksafe-exec-v1",
    resources: { cpu: 2, memoryGiB: 2, diskGiB: 10 }, provider,
  });
  const deadline = Date.now() + 240_000;
  let op = await ctx.runQuery(internal.sandboxes.getSandboxOp, { sandboxOpId: requested.sandboxOpId });
  while (op && op.status !== "ready" && Date.now() < deadline) {
    if (["error", "terminated"].includes(op.status)) break;
    await sleep(3_000);
    op = await ctx.runQuery(internal.sandboxes.getSandboxOp, { sandboxOpId: requested.sandboxOpId });
  }
  if (!op || op.status !== "ready") throw new ConvexError("evaluator_sandbox_not_ready");
  return op;
}

/** Evaluates one reserved job end to end, then schedules the next. */
export const evaluateNext = internalAction({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ action: string; jobId?: string }> => {
    const backend = evaluatorBackend(process.env.DAYTONA_EXECUTION_SNAPSHOT);
    const state = await ctx.runQuery(internal.evaluation.nextJob, { investigationId: args.investigationId });
    if (state.active) return { action: "busy" };
    if (!state.next) {
      await ctx.runMutation(internal.evaluation.advance, { investigationId: args.investigationId });
      return { action: "advanced" };
    }
    const jobId = state.next.appId as string;
    let claim;
    try {
      claim = await ctx.runMutation(internal.evaluation.claimEvaluation, { jobId });
    } catch (error) {
      if (error instanceof ConvexError && ["investigation_cancelling", "attempts_exhausted", "awaiting_grant_revocation", "lease_held"].includes(String(error.data))) {
        if (String(error.data) !== "awaiting_grant_revocation") await ctx.runMutation(internal.evaluation.advance, { investigationId: args.investigationId });
        return { action: String(error.data), jobId };
      }
      throw error;
    }
    const { claimed, candidate, source } = claim;
    const suite = (state.next.payload?.suite === "withheld" ? "withheld" : "public") as "public" | "withheld";
    const fail = async (outcome: "failed" | "infra_failed", error: string) => {
      await ctx.runMutation(internal.evaluation.completeEvaluation, { jobId, attemptId: claimed.attemptId, epoch: claimed.epoch, outcome, error });
      await ctx.scheduler.runAfter(1_000, internal.evaluation.evaluateNext, { investigationId: args.investigationId });
    };
    if (backend === "v2") {
      // TODO(PR #13): python -m evaluator.run_candidate
      await fail("infra_failed", "evaluator_v2_not_merged");
      return { action: "evaluator_v2_not_merged", jobId };
    }
    if (!candidate || !source) {
      await fail("failed", "candidate_source_missing");
      return { action: "failed", jobId };
    }
    const grant = await ctx.runMutation(internal.grants.create, { jobId, attemptId: claimed.attemptId, epoch: claimed.epoch, investigationId: args.investigationId, purpose: "evaluator" });
    const install = await ctx.runAction(internal.bridge.installGrant, {
      grantId: grant.grantId, jobId, attemptId: claimed.attemptId, epoch: claimed.epoch, investigationId: args.investigationId,
      operations: ["heartbeat", "record_artifact", "record_experiment", "record_evaluation"], artifactPrefixes: [`inv/${args.investigationId}/`],
      maxBytes: 64 * 1024 * 1024, expiresAtMs: grant.expiresAtMs,
    });
    if (!install.committed && (install.mode === "live" || install.mode === "local")) {
      await fail("infra_failed", install.error ?? "grant_install_failed");
      return { action: "grant_install_failed", jobId };
    }
    await ctx.runMutation(internal.evaluation.stageEvaluation, { jobId, attemptId: claimed.attemptId, epoch: claimed.epoch, stage: "grant_installed", detail: { grantId: grant.grantId, bridgeMode: install.mode } });
    let sandbox;
    try {
      sandbox = await freshEvaluatorSandbox(ctx, args.investigationId, jobId, claimed.attemptId);
    } catch (error) {
      await fail("infra_failed", error instanceof ConvexError ? String(error.data) : "evaluator_sandbox_failed");
      return { action: "sandbox_failed", jobId };
    }
    await ctx.runMutation(internal.evaluation.stageEvaluation, { jobId, attemptId: claimed.attemptId, epoch: claimed.epoch, stage: "work_started", detail: { sandboxOpId: sandbox.appId, suite } });
    const grantRef = { grantId: grant.grantId, attemptId: claimed.attemptId, epoch: claimed.epoch };
    const cases: { caseId: string; status: "passed" | "failed" | "invalid"; experimentId?: string; completionTimeSec?: number; failureKinds: string[] }[] = [];
    let fenced = false;
    let manifestRejected: string | undefined;
    const signingKeys = new Set<string>();
    const trustedKeys = backend === "v3" ? loadTrustedKeys(process.env) : null;
    try {
      for (const manifestCase of suites[suite]) {
        const beat = await ctx.runMutation(internal.evaluation.heartbeatEvaluation, { jobId, attemptId: claimed.attemptId, epoch: claimed.epoch });
        if (!beat.ok) { fenced = true; break; }
        if (backend === "v3") {
          const signedRun = await ctx.runAction(internal.execution.runSignedCase, {
            sandboxOpId: sandbox.appId, investigationId: args.investigationId, candidateId: candidate.appId, attemptId: claimed.attemptId,
            caseId: manifestCase.caseId, suite, controllerSource: source, controllerSha256: candidate.controllerSha256,
          });
          const verified = await verifySignedEvaluation(signedRun.document, {
            candidateId: candidate.appId, investigationId: args.investigationId, evaluatorAttemptId: claimed.attemptId,
            controllerSha256: candidate.controllerSha256, suite,
          }, trustedKeys);
          if (!verified.ok) {
            manifestRejected = verified.code;
            console.log("evaluation:manifest_rejected", jobId, manifestCase.caseId, verified.code, signedRun.exitCode);
            break;
          }
          signingKeys.add(verified.keyId);
          for (const signed of verified.cases) {
            const simCase = { caseId: manifestCase.caseId, suite, seed: manifestCase.seed, sceneOverrides: manifestCase.sceneOverrides ?? {}, ...(manifestCase.description ? { description: manifestCase.description } : {}) };
            const completed = signed.status === "passed" || signed.completionTimeSec !== undefined;
            const experimentStatus = signed.status === "passed" ? "succeeded" : signed.status === "invalid" ? "invalid" : classifyExperiment({ completed: false, failureKinds: signed.failureKinds });
            await ctx.runMutation(internal.evidence.reserveExperiment, {
              experimentId: signed.experimentId, investigationId: args.investigationId, candidateId: candidate.appId, attemptId: claimed.attemptId, epoch: claimed.epoch,
              grantId: grant.grantId, purpose: "evaluation", simCase, controllerSha256: candidate.controllerSha256, sandboxOpId: sandbox.appId, changedFunctions: candidate.changedFunctions,
            });
            let committed = false;
            try {
              const result = await ctx.runAction(internal.bridge.recordExperiment, {
                grant: grantRef, id: signed.experimentId, investigationId: args.investigationId, candidateId: candidate.appId, simCase, status: experimentStatus,
                failureKinds: signed.failureKinds, completed, ...(signed.completionTimeSec !== undefined ? { completionTimeSec: signed.completionTimeSec } : {}),
                changedFunctions: candidate.changedFunctions, engineVersion: verified.engineVersion, assetsSha256: verified.assetsSha256, controllerSha256: verified.controllerSha256,
                startedAtMs: Date.now() - signedRun.wallMs, finishedAtMs: Date.now(),
              });
              committed = result.committed;
            } catch {
              committed = false;
            }
            await ctx.runMutation(internal.evidence.finishExperiment, {
              experimentId: signed.experimentId, status: experimentStatus, failureKinds: signed.failureKinds, completed,
              ...(signed.completionTimeSec !== undefined ? { completionTimeSec: signed.completionTimeSec } : {}),
              ...(signed.firstFailure ? { firstFailure: signed.firstFailure } : {}),
              engineVersion: verified.engineVersion, assetsSha256: verified.assetsSha256, controllerSha256: verified.controllerSha256, spacetimeCommitted: committed,
            });
            cases.push({ caseId: signed.caseId, status: signed.status, experimentId: signed.experimentId, ...(signed.completionTimeSec !== undefined ? { completionTimeSec: signed.completionTimeSec } : {}), failureKinds: signed.failureKinds });
          }
          continue;
        }
        const experimentId = appId();
        const simCase = { caseId: manifestCase.caseId, suite, seed: manifestCase.seed, sceneOverrides: manifestCase.sceneOverrides ?? {}, ...(manifestCase.description ? { description: manifestCase.description } : {}) };
        await ctx.runMutation(internal.evidence.reserveExperiment, {
          experimentId, investigationId: args.investigationId, candidateId: candidate.appId, attemptId: claimed.attemptId, epoch: claimed.epoch,
          grantId: grant.grantId, purpose: "evaluation", simCase, controllerSha256: candidate.controllerSha256, sandboxOpId: sandbox.appId, changedFunctions: candidate.changedFunctions,
        });
        const outcome = await ctx.runAction(internal.execution.runCase, {
          sandboxOpId: sandbox.appId, investigationId: args.investigationId, attemptId: claimed.attemptId, experimentId, simCase, controllerSource: source, timeoutSec: 30,
        });
        const status = caseStatus({ completed: outcome.completed, failureKinds: outcome.failureKinds, controllerSha256: outcome.controllerSha256 }, candidate.controllerSha256);
        let committed = false;
        try {
          const result = await ctx.runAction(internal.bridge.recordExperiment, {
            grant: grantRef, id: experimentId, investigationId: args.investigationId, candidateId: candidate.appId, simCase, status: outcome.status,
            failureKinds: outcome.failureKinds, completed: outcome.completed, ...(outcome.completionTimeSec !== undefined ? { completionTimeSec: outcome.completionTimeSec } : {}),
            changedFunctions: candidate.changedFunctions, engineVersion: outcome.engineVersion, assetsSha256: outcome.assetsSha256, controllerSha256: outcome.controllerSha256,
            startedAtMs: Date.now() - outcome.wallMs, finishedAtMs: Date.now(),
          });
          committed = result.committed;
        } catch {
          committed = false;
        }
        await ctx.runMutation(internal.evidence.finishExperiment, {
          experimentId, status: outcome.status, failureKinds: outcome.failureKinds, completed: outcome.completed,
          ...(outcome.completionTimeSec !== undefined ? { completionTimeSec: outcome.completionTimeSec } : {}), ...(outcome.firstFailure ? { firstFailure: outcome.firstFailure } : {}),
          engineVersion: outcome.engineVersion, assetsSha256: outcome.assetsSha256, controllerSha256: outcome.controllerSha256,
          ...(outcome.traceArtifactId ? { traceArtifactId: outcome.traceArtifactId } : {}), ...(outcome.replayArtifactId ? { replayArtifactId: outcome.replayArtifactId } : {}), spacetimeCommitted: committed,
        });
        cases.push({ caseId: manifestCase.caseId, status, experimentId, ...(outcome.completionTimeSec !== undefined ? { completionTimeSec: outcome.completionTimeSec } : {}), failureKinds: outcome.failureKinds });
      }
    } finally {
      await ctx.scheduler.runAfter(0, internal.sandboxActions.terminate, { sandboxOpId: sandbox.appId });
    }
    if (fenced) return { action: "fenced", jobId };
    if (manifestRejected) {
      await fail("infra_failed", `signed_manifest_${manifestRejected}`);
      return { action: "manifest_rejected", jobId };
    }

    const allPassed = cases.length > 0 && cases.every((item) => item.status === "passed");
    const status = allPassed ? "passed" : cases.some((item) => item.status === "invalid") ? "invalid" : "failed";
    const medianTime = median(cases.filter((item) => item.status === "passed" && item.completionTimeSec !== undefined).map((item) => item.completionTimeSec!));
    const evaluationId = appId();
    await ctx.runMutation(internal.evaluation.insertEvaluation, {
      evaluationId, candidateId: candidate.appId, investigationId: args.investigationId, evaluatorAttemptId: claimed.attemptId, jobId, epoch: claimed.epoch,
      grantId: grant.grantId, suite, cases, allRequiredPassed: allPassed, ...(medianTime !== undefined ? { medianCompletionTimeSec: medianTime } : {}), status, sandboxOpId: sandbox.appId,
    });
    await ctx.runMutation(internal.evaluation.stageEvaluation, { jobId, attemptId: claimed.attemptId, epoch: claimed.epoch, stage: "artifacts_persisted", detail: { evaluationId, ...(signingKeys.size ? { manifestVerified: true, signedManifestKeyIds: [...signingKeys] } : {}) } });
    let committed = false;
    try {
      const result = await ctx.runAction(internal.bridge.recordEvaluation, {
        grant: grantRef, id: evaluationId, candidateId: candidate.appId, investigationId: args.investigationId, suite, cases, allRequiredPassed: allPassed,
        ...(medianTime !== undefined ? { medianCompletionTimeSec: medianTime } : {}), status,
      });
      committed = result.committed;
    } catch {
      committed = false;
    }
    await ctx.runMutation(internal.evidence.markCommitted, { table: "evaluations", appId: evaluationId, committed });
    await ctx.runMutation(internal.evaluation.stageEvaluation, { jobId, attemptId: claimed.attemptId, epoch: claimed.epoch, stage: "evidence_committed", detail: { evidenceIds: [evaluationId], spacetimeCommitted: committed } });
    await ctx.runMutation(internal.evaluation.completeEvaluation, { jobId, attemptId: claimed.attemptId, epoch: claimed.epoch, outcome: "succeeded" });
    await ctx.scheduler.runAfter(0, internal.evaluation.evaluateNext, { investigationId: args.investigationId });
    return { action: "evaluated", jobId };
  },
});

// Opens the FS review issue as soon as review is needed; the review reducer's own jira_sync row later updates it.
async function scheduleReviewIssue(ctx: any, investigationId: string): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.outbox.insert, {
    destination: "jira_sync", idempotencyKey: `awaiting_review:${investigationId}:jira_sync`, operationId: appId(),
    payload: { kind: "awaiting_review", investigationId }, source: "convex",
  });
}
