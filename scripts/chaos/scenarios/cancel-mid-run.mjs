import { randomUUID } from "node:crypto";
import { byInvestigation, isGone } from "../lib/daytona.mjs";
import { cancel, snapshot, waitFor } from "../lib/investigation.mjs";
import { postRunner } from "../lib/runnerHttp.mjs";
import { startRunner } from "../lib/runners.mjs";
import { captureInvestigation, preflight } from "../lib/scenario.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  if (!(await preflight(ctx, 2))) return;
  const captured = await captureInvestigation(ctx, 1, 10 * 60_000);
  if (!captured) return;
  const environment = captured.environments[0];
  const credential = captured.credentials[0];
  const runner = startRunner({
    envId: environment.appId,
    credential,
    workdir: ctx.workdir,
    tokenCap: 60_000,
  });
  ctx.runners.push(runner);
  const experimentState = await waitFor(async () => {
    const state = await snapshot(ctx.investigationId);
    const experiment = state.experiments.find((item) =>
      item.environmentId === environment.appId && item.purpose === "development");
    if (experiment) return { state, experiment };
    return null;
  }, { timeoutMs: 10 * 60_000, intervalMs: 3_000 });
  if (!experimentState) {
    for (const id of ["C1", "C2", "C3", "C4", "C5"]) {
      ctx.checks.notReached(id, "cancellation fences and cleans all live work", "no agent-run experiment reached the investigation");
    }
    return;
  }
  const activeJob = experimentState.state.jobs.find((job) =>
    job.kind === "factory_session" && job.environmentId === environment.appId);
  const activeAttempt = experimentState.state.attempts.find((attempt) =>
    attempt.appId === activeJob?.activeAttemptId);
  const activeGrant = experimentState.state.grants.find((grant) => grant.attemptId === activeAttempt?.appId);
  ctx.ids.jobId = activeJob?.appId ?? null;
  ctx.ids.attemptId = activeAttempt?.appId ?? null;
  ctx.ids.grantId = activeGrant?.appId ?? activeAttempt?.grantId ?? null;

  const cancelAtMs = Date.now();
  ctx.evidence.cancelAtMs = cancelAtMs;
  const cancelResponse = await cancel(ctx.investigationId);
  ctx.evidence.cancelResponse = cancelResponse;
  const staleCompleteBody = {
    operationId: randomUUID(),
    jobId: activeJob?.appId,
    attemptId: activeAttempt?.appId,
    grantId: activeGrant?.appId ?? activeAttempt?.grantId,
    epoch: activeAttempt?.epoch,
    outcome: "succeeded",
    result: { chaos: "cancelled-runner-replay" },
    sessions: [],
    finishedAtMs: Date.now(),
  };
  const staleComplete = activeJob && activeAttempt && (activeGrant?.appId || activeAttempt.grantId)
    ? await postRunner(ctx.siteUrl, credential, "complete", staleCompleteBody)
    : { status: 0, json: { accepted: false, reason: "active_attempt_or_grant_missing" } };
  const replayAttempted = Boolean(activeJob && activeAttempt && (activeGrant?.appId || activeAttempt.grantId));

  const deadline = cancelAtMs + 90_000;
  let state;
  let revokedAtMs;
  let sandboxesGoneAtMs;
  let cancelledAtMs;
  let sandboxPresence = [];
  while (Date.now() <= deadline) {
    state = await snapshot(ctx.investigationId);
    const grantsRevoked = state.grants.length > 0
      && state.grants.every((grant) => grant.revokedAtMs !== undefined && grant.spacetimeRevoked === true);
    if (grantsRevoked) revokedAtMs ??= Date.now();

    const opStates = state.sandboxOps.every((op) => op.status === "terminated");
    const opIdsGone = await Promise.all(state.sandboxOps.map(async (op) => ({
      sandboxOpId: op.appId,
      sandboxId: op.sandbox?.id ?? null,
      gone: op.sandbox?.id ? await isGone(op.sandbox.id) : true,
      status: op.status,
    })));
    const daytonaRows = await byInvestigation(ctx.investigationId);
    sandboxPresence = { opIdsGone, daytonaRows };
    const gone = state.sandboxOps.length > 0
      && opStates
      && opIdsGone.every((item) => item.gone)
      && daytonaRows.length === 0;
    if (gone) sandboxesGoneAtMs ??= Date.now();
    const allCredentialsRevoked = state.runnerCredentials.length > 0
      && state.runnerCredentials.every((row) => row.revokedAtMs !== undefined);
    if (state.investigation?.state === "cancelled"
      && state.investigation.cancelStatus === "cancelled"
      && allCredentialsRevoked) cancelledAtMs ??= Date.now();

    if (Date.now() >= cancelAtMs + 60_000 && cancelledAtMs) break;
    await sleep(2_000);
  }
  const finalState = state ?? await snapshot(ctx.investigationId);
  const c1ElapsedMs = revokedAtMs === undefined ? null : revokedAtMs - cancelAtMs;
  const c2ElapsedMs = sandboxesGoneAtMs === undefined ? null : sandboxesGoneAtMs - cancelAtMs;
  ctx.checks.check(
    "C1",
    "all execution grants are revoked in Convex and SpacetimeDB within 60 seconds",
    c1ElapsedMs !== null && c1ElapsedMs <= 60_000,
    { elapsedMs: c1ElapsedMs, grants: finalState.grants },
  );
  ctx.checks.check(
    "C2",
    "all investigation sandbox operations terminate and Daytona sandboxes are gone within 60 seconds",
    c2ElapsedMs !== null && c2ElapsedMs <= 60_000,
    { elapsedMs: c2ElapsedMs, sandboxes: sandboxPresence, sandboxOps: finalState.sandboxOps },
  );
  const postCancelCandidates = finalState.candidates.filter((candidate) => candidate.submittedAtMs > cancelAtMs);
  ctx.checks.check(
    "C3",
    "no candidate is submitted after cancellation",
    postCancelCandidates.length === 0,
    { cancelAtMs, postCancelCandidates, candidates: finalState.candidates },
  );

  const afterReplay = await waitFor(async () => {
    const current = await snapshot(ctx.investigationId);
    const job = current.jobs.find((item) => item.appId === activeJob?.appId);
    if (job && ["cancelled", "succeeded", "failed"].includes(job.state)) return { current, job };
    return null;
  }, { timeoutMs: Math.max(1, deadline - Date.now()), intervalMs: 2_000 });
  const finalJob = afterReplay?.job
    ?? finalState.jobs.find((item) => item.appId === activeJob?.appId)
    ?? null;
  const replayRejected = replayAttempted && (staleComplete.status === 401
    || staleComplete.json?.accepted === false
    || staleComplete.json?.rejected === true);
  ctx.checks.check(
    "C4",
    "post-cancel completion replay is rejected and the job ends cancelled, never succeeded",
    Boolean(replayRejected && finalJob?.state === "cancelled"),
    {
      cancelAtMs,
      completeBody: staleCompleteBody,
      completeResponse: staleComplete,
      replayAttempted,
      finalJob,
    },
  );
  const credentialsRevoked = finalState.runnerCredentials.length > 0
    && finalState.runnerCredentials.every((row) => row.revokedAtMs !== undefined);
  const c5ElapsedMs = cancelledAtMs === undefined ? null : cancelledAtMs - cancelAtMs;
  ctx.checks.check(
    "C5",
    "investigation and cancelStatus reach cancelled and all runner credentials are revoked within 90 seconds",
    finalState.investigation?.state === "cancelled"
      && finalState.investigation?.cancelStatus === "cancelled"
      && credentialsRevoked
      && c5ElapsedMs !== null
      && c5ElapsedMs <= 90_000,
    {
      elapsedMs: c5ElapsedMs,
      investigation: finalState.investigation,
      runnerCredentials: finalState.runnerCredentials.map(({ appId, revokedAtMs, expiresAtMs }) => ({ appId, revokedAtMs, expiresAtMs })),
    },
  );
  ctx.tokens = finalState.sessions.reduce((sum, session) => {
    const usage = session.tokenUsage ?? {};
    return sum + ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]
      .reduce((count, key) => count + (Number(usage[key]) || 0), 0);
  }, 0);
}
