import { randomUUID } from "node:crypto";
import { activeTurnsAt, kill, startRunner } from "../lib/runners.mjs";
import { postRunner } from "../lib/runnerHttp.mjs";
import { captureInvestigation, preflight } from "../lib/scenario.mjs";
import { snapshot, waitFor } from "../lib/investigation.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jobForEnvironment(state, environmentId) {
  return state.jobs.find((job) => job.kind === "factory_session" && job.environmentId === environmentId);
}

function tokenCount(session) {
  const usage = session.tokenUsage ?? {};
  return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]
    .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
}

async function recordSessionEvidence(ctx, state) {
  if (!state && !ctx.investigationId) return;
  const snapshotState = state ?? await snapshot(ctx.investigationId);
  const sessions = snapshotState.sessions.map((session) => ({
    sessionId: session.appId,
    factorySessionId: session.factorySession?.provider === "factory" ? session.factorySession.id : null,
    state: session.state,
    turns: session.turns ?? 0,
    tokenUsage: session.tokenUsage ?? {},
    unknownUsageTurns: session.usageUnknownTurns ?? 0,
    partialUsageTurns: session.usagePartialTurns ?? 0,
    tokens: tokenCount(session),
  }));
  ctx.tokens = sessions.reduce((sum, session) => sum + session.tokens, 0);
  ctx.unknownUsageTurns = sessions.reduce((sum, session) => sum + session.unknownUsageTurns, 0);
  ctx.evidence.sessions = sessions;
}

export async function run(ctx) {
  if (!(await preflight(ctx, 2))) return;
  const captured = await captureInvestigation(ctx, 1, 8 * 60_000);
  if (!captured) {
    await recordSessionEvidence(ctx);
    return;
  }
  const environment = captured.environments[0];
  const credential = captured.credentials[0];
  ctx.ids.environmentId = environment.appId;
  const runner1 = startRunner({
    envId: environment.appId,
    credential,
    workdir: ctx.workdir,
    tokenCap: ctx.options.tokenCap,
  });
  ctx.runners.push(runner1);
  const runningTurn = await waitFor(async () => {
    const state = await snapshot(ctx.investigationId);
    const job = jobForEnvironment(state, environment.appId);
    const acquired = activeTurnsAt([runner1.probeFile]);
    if (job?.state === "running" && acquired > 0) return { state, job, acquired };
    return null;
  }, { timeoutMs: 8 * 60_000, intervalMs: 2_000 });
  ctx.checks.check(
    "K0",
    "R1 has an open model turn while its job is running",
    Boolean(runningTurn),
    runningTurn ? { jobId: runningTurn.job.appId, state: runningTurn.job.state, activeTurns: runningTurn.acquired } : { runner: runner1.workerId },
  );
  if (!runningTurn) {
    await recordSessionEvidence(ctx);
    return;
  }

  const attempt1Id = runningTurn.job.activeAttemptId;
  const attempt1BeforeKill = runningTurn.state.attempts.find((attempt) => attempt.appId === attempt1Id);
  ctx.ids.jobId = runningTurn.job.appId;
  ctx.ids.attempt1Id = attempt1Id;
  await sleep(10_000);
  const killAt = Date.now();
  kill(runner1, "SIGKILL");
  ctx.evidence.killAtMs = killAt;

  const expired = await waitFor(async () => {
    const state = await snapshot(ctx.investigationId);
    const attempt = state.attempts.find((item) => item.appId === attempt1Id);
    if (attempt && !["leased", "heartbeating"].includes(attempt.state)) return { state, attempt };
    return null;
  }, { timeoutMs: 90_000, intervalMs: 1_000 });
  const attempt1 = expired?.attempt;
  const expiredAtMs = attempt1?.endedAtMs;
  const leaseElapsedMs = expiredAtMs === undefined ? null : expiredAtMs - killAt;
  const leaseRemainingAtKillMs = attempt1?.leasedUntilMs === undefined ? null : attempt1.leasedUntilMs - killAt;
  ctx.checks.check(
    "K1",
    "killed attempt expires 25–35 seconds after kill and was leased for no more than 30 more seconds",
    Boolean(attempt1
      && attempt1.state === "expired"
      && leaseElapsedMs >= 25_000
      && leaseElapsedMs <= 35_000
      && leaseRemainingAtKillMs <= 30_000),
    {
      killAtMs: killAt,
      attempt1BeforeKill,
      attempt1,
      expiredAtMs,
      leaseElapsedMs,
      leaseRemainingAtKillMs,
    },
  );
  if (!expired) {
    await recordSessionEvidence(ctx);
    return;
  }

  const reservedState = await waitFor(async () => {
    const state = await snapshot(ctx.investigationId);
    const job = state.jobs.find((item) => item.appId === runningTurn.job.appId);
    if (job?.state === "reserved" && job.attemptsUsed === 1) return { state, job };
    return null;
  }, { timeoutMs: 60_000, intervalMs: 1_000 });
  const pendingRevocation = reservedState?.job?.pendingRevocation;
  // grants.markRevoked clears pendingRevocation once SpacetimeDB confirms the revoke, so a
  // fast revoke shows up as a revoked attempt-one grant instead of a pending marker.
  const attempt1AfterExpiry = reservedState?.state.attempts.find((attempt) => attempt.appId === attempt1Id);
  const attempt1Grants = reservedState?.state.grants.filter((grant) => grant.attemptId === attempt1Id) ?? [];
  const attempt1GrantRevoked = attempt1AfterExpiry?.grantRevokedAtMs !== undefined
    && attempt1Grants.length > 0
    && attempt1Grants.every((grant) => grant.revokedAtMs !== undefined && grant.spacetimeRevoked === true);
  ctx.checks.check(
    "K2",
    "expired job is reserved for one retry and attempt one's grant is pending revocation or already revoked",
    Boolean(reservedState
      && reservedState.job.attemptsUsed === 1
      && (pendingRevocation?.attemptId === attempt1Id || attempt1GrantRevoked)),
    {
      job: reservedState?.job ?? null,
      pendingRevocation: pendingRevocation ?? null,
      attempt1GrantRevokedAtMs: attempt1AfterExpiry?.grantRevokedAtMs ?? null,
      attempt1Grants: attempt1Grants.map(({ appId, revokedAtMs, spacetimeRevoked, revokeReason }) => ({ appId, revokedAtMs, spacetimeRevoked, revokeReason })),
    },
  );
  if (!reservedState) {
    await recordSessionEvidence(ctx);
    return;
  }

  const runner2 = startRunner({
    envId: environment.appId,
    credential,
    workdir: ctx.workdir,
    tokenCap: ctx.options.tokenCap,
  });
  ctx.runners.push(runner2);
  const attempt2Ready = await waitFor(async () => {
    const state = await snapshot(ctx.investigationId);
    const job = state.jobs.find((item) => item.appId === runningTurn.job.appId);
    const attempt2 = state.attempts.find((attempt) => attempt.appId === job?.activeAttemptId);
    if (job?.activeAttemptId && job.activeAttemptId !== attempt1Id && attempt2) return { state, job, attempt2 };
    return null;
  }, { timeoutMs: 120_000, intervalMs: 1_000 });
  ctx.checks.check(
    "K3",
    "R2 claims attempt two at a higher epoch and becomes the active attempt",
    Boolean(attempt2Ready
      && attempt2Ready.attempt2.epoch > (attempt1?.epoch ?? -1)
      && attempt2Ready.job.activeAttemptId === attempt2Ready.attempt2.appId),
    attempt2Ready ? { job: attempt2Ready.job, attempt2: attempt2Ready.attempt2 } : { jobId: runningTurn.job.appId },
  );
  if (!attempt2Ready) {
    await recordSessionEvidence(ctx);
    return;
  }
  ctx.ids.attempt2Id = attempt2Ready.attempt2.appId;
  const stateBeforeReplay = await snapshot(ctx.investigationId);
  const attempt1Session = stateBeforeReplay.sessions.find((session) => session.attemptId === attempt1Id);
  const grant1 = stateBeforeReplay.grants.find((grant) => grant.attemptId === attempt1Id);
  const grantId = attempt1?.grantId ?? grant1?.appId;
  const oldSessionId = attempt1Session?.appId ?? randomUUID();
  const replayAtMs = Date.now();
  const staleHeartbeat = await postRunner(ctx.siteUrl, credential, "heartbeat", {
    attemptId: attempt1Id,
    grantId,
    epoch: attempt1?.epoch,
  });
  const staleCompleteBody = {
    operationId: randomUUID(),
    jobId: runningTurn.job.appId,
    attemptId: attempt1Id,
    grantId,
    epoch: attempt1?.epoch,
    outcome: "succeeded",
    result: { chaos: "stale" },
    sessions: [],
    finishedAtMs: Date.now(),
  };
  const staleComplete = await postRunner(ctx.siteUrl, credential, "complete", staleCompleteBody);
  const staleTool = await postRunner(ctx.siteUrl, credential, "tools/read_findings", {
    investigationId: ctx.investigationId,
    environmentId: environment.appId,
    sessionId: oldSessionId,
    attemptId: attempt1Id,
    grantId,
    epoch: attempt1?.epoch,
    scope: "investigation",
    limit: 5,
  });
  const stateAfterReplay = await snapshot(ctx.investigationId);
  const jobAfterReplay = stateAfterReplay.jobs.find((item) => item.appId === runningTurn.job.appId);
  const attempt2AfterReplay = stateAfterReplay.attempts.find((attempt) => attempt.appId === attempt2Ready.attempt2.appId);
  const staleAcknowledgements = stateAfterReplay.handoffs.filter((handoff) =>
    handoff.attemptId === attempt1Id
    && handoff.stage === "completion_acknowledged"
    && handoff.stale === false
    && handoff.atMs >= replayAtMs);
  const rejectedHeartbeat = staleHeartbeat.json?.ok === false;
  const rejectedComplete = staleComplete.status >= 400 || staleComplete.json?.accepted === false;
  const rejectedTool = staleTool.status >= 400 || Boolean(staleTool.json?.error);
  const stateClass = (state) => ["leased", "heartbeating", "completing"].includes(state) ? "live" : state;
  const noEffects = jobAfterReplay?.activeAttemptId === attempt2Ready.attempt2.appId
    && jobAfterReplay?.epoch === attempt2Ready.attempt2.epoch
    && stateClass(attempt2AfterReplay?.state) === stateClass(attempt2Ready.attempt2.state)
    && staleAcknowledgements.length === 0;
  const replayEvidence = {
    replayAtMs,
    heartbeat: staleHeartbeat,
    complete: { body: staleCompleteBody, ...staleComplete },
    readFindings: staleTool,
    jobBefore: attempt2Ready.job,
    jobAfter: jobAfterReplay,
    attempt2Before: attempt2Ready.attempt2,
    attempt2After: attempt2AfterReplay,
    staleAcknowledgements,
  };
  ctx.checks.check("K4", "stale attempt requests are rejected without effects", rejectedHeartbeat && rejectedComplete && rejectedTool && noEffects, replayEvidence);
  const strictStale = [staleHeartbeat, staleComplete, staleTool].every((response) =>
    response.status === 409 && ["stale_epoch"].includes(response.json?.reason ?? response.json?.error));
  ctx.checks.check("K5", "each stale replay returns HTTP 409 with stale_epoch", strictStale, replayEvidence, "strict");

  const terminal = await waitFor(async () => {
    const state = await snapshot(ctx.investigationId);
    const job = state.jobs.find((item) => item.appId === runningTurn.job.appId);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.state)) return { state, job };
    return null;
  }, { timeoutMs: 8 * 60_000, intervalMs: 2_000 });
  const finalState = terminal?.state ?? await snapshot(ctx.investigationId);
  const attempts = finalState.attempts.filter((attempt) => attempt.jobId === runningTurn.job.appId);
  const job = terminal?.job ?? finalState.jobs.find((item) => item.appId === runningTurn.job.appId);
  await recordSessionEvidence(ctx, finalState);
  ctx.checks.check(
    "K6",
    "runner kill causes exactly one infrastructure retry",
    Boolean(terminal && attempts.length === 2 && job?.attemptsUsed === 2),
    { terminal: Boolean(terminal), job, attempts },
  );
}
