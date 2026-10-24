import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { inlineQuery, redactSecrets, runFn } from "../lib/convex.mjs";
import { snapshot } from "../lib/investigation.mjs";
import { captureInvestigation, preflight } from "../lib/scenario.mjs";
import { postRunner } from "../lib/runnerHttp.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  if (!(await preflight(ctx, 2))) return;
  const captured = await captureInvestigation(ctx, 1, 8 * 60_000);
  if (!captured) return;
  const environment = captured.environments[0];
  const credential = captured.credentials[0];
  ctx.ids.environmentId = environment.appId;

  const claimBody = { workerId: "chaos-harness", kinds: ["factory_session"], capacity: 1 };
  const claimDeadline = Date.now() + 60_000;
  let claimResponse = null;
  while (Date.now() <= claimDeadline) {
    claimResponse = await postRunner(ctx.siteUrl, credential, "claim", claimBody);
    if (claimResponse.json?.lease) break;
    await sleep(3_000);
  }
  const lease = claimResponse?.json?.lease;
  ctx.ids.jobId = lease?.job?.id;
  ctx.ids.attemptId = lease?.attempt?.id;
  ctx.ids.grantId = lease?.grant?.id;
  if (lease) {
    ctx.cleanupHook = async () => {
      const state = await snapshot(ctx.investigationId);
      const job = state.jobs.find((item) => item.appId === lease.job.id);
      if (!job || ["succeeded", "failed", "cancelled"].includes(job.state)) {
        return { attempted: false, jobState: job?.state ?? null };
      }
      const attempt = state.attempts.find((item) => item.appId === lease.attempt.id);
      const grant = state.grants.find((item) => item.appId === lease.grant.id);
      if (!attempt || !grant) return { attempted: false, reason: "active attempt or grant not found" };
      const response = await postRunner(ctx.siteUrl, credential, "complete", {
        operationId: job.operationId,
        jobId: job.appId,
        attemptId: attempt.appId,
        grantId: grant.appId,
        epoch: attempt.epoch,
        outcome: "failed",
        result: { chaos: "cleanup" },
        sessions: [],
        finishedAtMs: Date.now(),
      });
      return { attempted: true, status: response.status, response: response.json };
    };
  }
  ctx.checks.check(
    "D0_CLAIM",
    "harness claims the reserved factory_session without starting a runner",
    Boolean(lease && claimResponse.status === 200),
    { status: claimResponse?.status, response: claimResponse?.json },
  );
  if (!lease) return;

  const now = Date.now();
  const sessionId = randomUUID();
  const sessionBody = {
    attemptId: lease.attempt.id,
    epoch: lease.attempt.epoch,
    session: {
      id: sessionId,
      state: "idle",
      mode: "fixture",
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        usageKnown: false,
      },
      createdAtMs: now,
    },
  };
  const sessionResponse = await postRunner(ctx.siteUrl, credential, "session", sessionBody);
  const startResponse = await postRunner(ctx.siteUrl, credential, "start", {
    attemptId: lease.attempt.id,
    epoch: lease.attempt.epoch,
  });
  const setupPassed = sessionResponse.status === 200 && startResponse.status === 200;
  ctx.checks.check(
    "D0_SESSION_START",
    "fixture session registers and the claimed job is marked started",
    setupPassed,
    { session: sessionResponse, start: startResponse },
  );

  const findingBody = {
    investigationId: ctx.investigationId,
    environmentId: environment.appId,
    sessionId,
    attemptId: lease.attempt.id,
    grantId: lease.grant.id,
    epoch: lease.attempt.epoch,
    callId: randomUUID(),
    kind: "behavioral_note",
    claim: "inference",
    summary: "chaos duplicate-delivery probe (harness traffic, not agent output)",
    evidence: [{
      kind: "log_excerpt",
      locator: { source: "chaos" },
      excerpt: "duplicate-delivery probe",
    }],
  };
  const firstFinding = await postRunner(ctx.siteUrl, credential, "tools/write_finding", findingBody);
  const secondFinding = await postRunner(ctx.siteUrl, credential, "tools/write_finding", findingBody);
  const findingRows = await inlineQuery(`
    const rows = await ctx.db.query("findings")
      .withIndex("by_investigation", q => q.eq("investigationId", ${JSON.stringify(ctx.investigationId)})).collect();
    return { count: rows.length };
  `);
  const d1Evidence = {
    first: firstFinding,
    second: secondFinding,
    findingRows: findingRows.count,
  };
  ctx.checks.check(
    "D1",
    "duplicate write_finding returns the original response and creates one Convex finding",
    isDeepStrictEqual(firstFinding, secondFinding) && findingRows.count === 1,
    d1Evidence,
  );
  if (firstFinding.json?.sharedToSpacetime === true) {
    let sharedCount;
    let bridgeError;
    try {
      sharedCount = await runFn("bridge:countRows", { investigationId: ctx.investigationId });
    } catch (error) {
      bridgeError = redactSecrets(error?.message ?? error);
    }
    const count = sharedCount?.finding
      ?? sharedCount?.findings
      ?? sharedCount?.counts?.finding
      ?? sharedCount?.counts?.findings;
    ctx.checks.check(
      "D1_SPACETIME",
      "SpacetimeDB contains exactly one finding when the first write was shared",
      count === 1,
      { sharedToSpacetime: true, count: count ?? null, result: sharedCount ?? null, error: bridgeError ?? null },
    );
  } else {
    ctx.checks.notReached(
      "D1_SPACETIME",
      "SpacetimeDB finding row count is checked only after a shared write",
      "the first write_finding response did not have sharedToSpacetime:true",
      { firstResponse: firstFinding },
    );
  }

  const beforeCompletion = await inlineQuery(`
    const job = await ctx.db.query("jobs").withIndex("by_appId", q => q.eq("appId", ${JSON.stringify(lease.job.id)})).unique();
    return job;
  `);
  const completeBody = {
    operationId: beforeCompletion?.operationId ?? randomUUID(),
    jobId: lease.job.id,
    attemptId: lease.attempt.id,
    grantId: lease.grant.id,
    epoch: lease.attempt.epoch,
    outcome: "failed",
    result: { chaos: "duplicate-delivery" },
    sessions: [],
    finishedAtMs: Date.now(),
  };
  const completeRawBody = JSON.stringify(completeBody);
  const firstComplete = await postRunner(ctx.siteUrl, credential, "complete", completeRawBody);
  const secondComplete = await postRunner(ctx.siteUrl, credential, "complete", completeRawBody);
  const finalState = await inlineQuery(`
    const job = await ctx.db.query("jobs").withIndex("by_appId", q => q.eq("appId", ${JSON.stringify(lease.job.id)})).unique();
    const attempts = await ctx.db.query("attempts").withIndex("by_job", q => q.eq("jobId", ${JSON.stringify(lease.job.id)})).collect();
    const handoffs = job
      ? await ctx.db.query("handoffs").withIndex("by_operation", q => q.eq("operationId", job.operationId)).collect()
      : [];
    return { job, attempts, handoffs };
  `);
  const acknowledged = finalState.handoffs.filter((handoff) =>
    handoff.stage === "completion_acknowledged" && handoff.stale === false);
  const d2Passed = finalState.job?.state === "failed"
    && finalState.job?.attemptsUsed === 1
    && finalState.attempts.length === 1
    && finalState.attempts[0]?.state === "failed"
    && acknowledged.length === 1;
  const completionEvidence = {
    firstBody: completeBody,
    secondBody: completeBody,
    first: firstComplete,
    second: secondComplete,
    job: finalState.job,
    attempts: finalState.attempts,
    completionAcknowledged: acknowledged,
  };
  ctx.checks.check("D2", "duplicate completion applies the failed outcome and handoff once", d2Passed, completionEvidence);
  ctx.checks.check(
    "D3",
    "duplicate completion replays the original acknowledgement",
    isDeepStrictEqual(firstComplete, secondComplete),
    completionEvidence,
    "strict",
  );

  const evaluation = await inlineQuery(`
    const rows = await ctx.db.query("evaluations").collect();
    return rows.filter(row => row.status === "passed").sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
  `);
  if (!evaluation) {
    ctx.checks.notReached("D4", "existing passed evaluation insertion is idempotent", "no existing passed evaluation row was found");
    ctx.checks.notReached("D5", "completed evaluation replay is rejected without effects", "no existing passed evaluation row was found");
    return;
  }
  ctx.ids.evaluationId = evaluation.appId;
  const evaluationBeforeResult = await inlineQuery(`
    const row = await ctx.db.query("evaluations")
      .withIndex("by_appId", q => q.eq("appId", ${JSON.stringify(evaluation.appId)})).unique();
    return { row };
  `);
  const evaluationBefore = evaluationBeforeResult?.row ?? null;
  if (!evaluation.jobId) {
    ctx.checks.notReached("D4", "existing passed evaluation insertion is idempotent", "the existing row has no jobId accepted by evaluation:insertEvaluation", { evaluationId: evaluation.appId });
    ctx.checks.notReached("D5", "completed evaluation replay is rejected without effects", "the existing row has no jobId", { evaluationId: evaluation.appId });
    return;
  }
  const evaluationArgs = {
    evaluationId: evaluation.appId,
    candidateId: evaluation.candidateId,
    investigationId: evaluation.investigationId,
    evaluatorAttemptId: evaluation.evaluatorAttemptId,
    jobId: evaluation.jobId,
    epoch: evaluation.epoch,
    suite: evaluation.suite,
    cases: evaluation.cases,
    allRequiredPassed: evaluation.allRequiredPassed,
    status: evaluation.status,
    ...(evaluation.grantId !== undefined ? { grantId: evaluation.grantId } : {}),
    ...(evaluation.medianCompletionTimeSec !== undefined ? { medianCompletionTimeSec: evaluation.medianCompletionTimeSec } : {}),
    ...(evaluation.sandboxOpId !== undefined ? { sandboxOpId: evaluation.sandboxOpId } : {}),
  };
  let insertResponse;
  let insertError;
  try {
    insertResponse = await runFn("evaluation:insertEvaluation", evaluationArgs);
  } catch (error) {
    insertError = redactSecrets(error?.message ?? error);
  }
  const evaluationAfterResult = await inlineQuery(`
    const rows = await ctx.db.query("evaluations").withIndex("by_appId", q => q.eq("appId", ${JSON.stringify(evaluation.appId)})).collect();
    return { rows };
  `);
  const evaluationAfter = evaluationAfterResult?.rows ?? [];
  const evaluationAfterRow = evaluationAfter[0] ?? null;
  ctx.checks.check(
    "D4",
    "replaying a real passed evaluation is a duplicate and does not mutate the row",
    insertResponse?.duplicate === true
      && evaluationAfter.length === 1
      && evaluationBefore?._creationTime === evaluationAfterRow?._creationTime
      && evaluationBefore?.updatedAtMs === evaluationAfterRow?.updatedAtMs,
    {
      evaluationArgs,
      response: insertResponse ?? null,
      error: insertError ?? null,
      before: evaluationBefore,
      after: evaluationAfter,
    },
  );

  const completionBefore = await inlineQuery(`
    const job = await ctx.db.query("jobs").withIndex("by_appId", q => q.eq("appId", ${JSON.stringify(evaluation.jobId)})).unique();
    const attempt = await ctx.db.query("attempts").withIndex("by_appId", q => q.eq("appId", ${JSON.stringify(evaluation.evaluatorAttemptId)})).unique();
    return { job, attempt };
  `);
  let completionResponse;
  let completionError;
  try {
    completionResponse = await runFn("evaluation:completeEvaluation", {
      jobId: evaluation.jobId,
      attemptId: evaluation.evaluatorAttemptId,
      epoch: evaluation.epoch,
      outcome: "succeeded",
    });
  } catch (error) {
    completionError = redactSecrets(error?.message ?? error);
  }
  const completionAfter = await inlineQuery(`
    const job = await ctx.db.query("jobs").withIndex("by_appId", q => q.eq("appId", ${JSON.stringify(evaluation.jobId)})).unique();
    const attempt = await ctx.db.query("attempts").withIndex("by_appId", q => q.eq("appId", ${JSON.stringify(evaluation.evaluatorAttemptId)})).unique();
    return { job, attempt };
  `);
  const rejected = completionError !== undefined || completionResponse?.rejected === true;
  ctx.checks.check(
    "D5",
    "replaying evaluation completion is rejected without changing its job or attempt",
    rejected
      && completionBefore.job?.state === completionAfter.job?.state
      && completionBefore.job?.updatedAtMs === completionAfter.job?.updatedAtMs
      && completionBefore.attempt?.state === completionAfter.attempt?.state,
    {
      response: completionResponse ?? null,
      error: completionError ?? null,
      before: completionBefore,
      after: completionAfter,
    },
  );
}
