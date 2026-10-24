import { activeTurnsAt, startRunner } from "../lib/runners.mjs";
import { capture, credentialFor, snapshot } from "../lib/investigation.mjs";
import { preflight } from "../lib/scenario.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tokenCount(session) {
  const usage = session.tokenUsage ?? {};
  return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]
    .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
}

export async function run(ctx) {
  const envs = ctx.options.envs;
  if (!(await preflight(ctx, 1))) return;
  const captured = await capture({ title: "", envs, runId: ctx.runId, scenario: ctx.scenario });
  ctx.captureResponse = captured;
  if (!captured?.accepted || !captured.investigationId) {
    ctx.checks.check("CAPTURE", "hosted Convex capture is accepted", false, captured ?? { error: "empty response" });
    return;
  }
  ctx.investigationId = captured.investigationId;
  ctx.ids.investigationId = captured.investigationId;
  ctx.checks.check("CAPTURE", "hosted Convex capture is accepted", true, { investigationId: captured.investigationId, envs });

  const deadline = Date.now() + ctx.options.timeoutMin * 60_000;
  const runnersByEnvironment = new Map();
  const probeFiles = [];
  const turnSamples = [];
  const snapshotCadenceMs = [];
  const snapshotSummaries = [];
  const everActive = new Set();
  const runnerOpsSeen = new Set();
  const newSandboxOpIds = new Set();
  let maxActiveTurns = 0;
  let maxModelReservations = 0;
  let maxSandboxReservations = ctx.preflight.activeSandboxReservationCount;
  let maxDaytonaSandboxes = ctx.preflight.forksafeDaytonaSandboxes;
  let searchingAtMs;
  let lastNewSandboxAtMs;
  let stall = false;
  let latestSnapshot;
  let previousSnapshotAt;
  let stopping = false;
  let runnerError;

  const turnSampler = async () => {
    while (!stopping && Date.now() < deadline) {
      const at = Date.now();
      const active = activeTurnsAt(probeFiles, at);
      turnSamples.push({ t: at, activeTurns: active });
      maxActiveTurns = Math.max(maxActiveTurns, active);
      await sleep(Math.max(0, 1_000 - (Date.now() - at)));
    }
  };

  const pollSnapshots = async () => {
    while (!stopping && Date.now() < deadline) {
      const startedAt = Date.now();
      const state = await snapshot(ctx.investigationId);
      latestSnapshot = state;
      if (previousSnapshotAt !== undefined) snapshotCadenceMs.push(startedAt - previousSnapshotAt);
      previousSnapshotAt = startedAt;
      snapshotSummaries.push({
        startedAtMs: startedAt,
        completedAtMs: Date.now(),
        investigationState: state.investigation?.state,
        environments: state.environments.map(({ appId, state: envState }) => ({ appId, state: envState })),
        sandboxOps: state.sandboxOps.map(({ appId, status, purpose, environmentId }) => ({ appId, status, purpose, environmentId })),
        activeSandboxReservations: state.global.activeSandboxReservationCount,
        activeModelTurnReservations: state.global.activeModelTurnReservations,
      });
      maxSandboxReservations = Math.max(maxSandboxReservations, state.global.activeSandboxReservationCount);
      maxModelReservations = Math.max(maxModelReservations, state.global.activeModelTurnReservations);

      if (state.investigation?.state === "searching") {
        searchingAtMs ??= Date.now();
        lastNewSandboxAtMs ??= searchingAtMs;
      }
      for (const environment of state.environments) {
        if (environment.state === "active") everActive.add(environment.appId);
        const op = state.sandboxOps.find((item) =>
          item.purpose === "runner" && item.environmentId === environment.appId);
        if (op) {
          runnerOpsSeen.add(environment.appId);
          if (!newSandboxOpIds.has(op.appId)) {
            newSandboxOpIds.add(op.appId);
            lastNewSandboxAtMs = Date.now();
          }
        }
        if (environment.state === "active" && !runnersByEnvironment.has(environment.appId)) {
          const credential = await credentialFor(environment.appId);
          if (credential) {
            credential.investigationId = ctx.investigationId;
            const runner = startRunner({
              envId: environment.appId,
              credential,
              workdir: ctx.workdir,
              tokenCap: ctx.options.tokenCap,
            });
            runnersByEnvironment.set(environment.appId, runner);
            ctx.runners.push(runner);
            probeFiles.push(runner.probeFile);
          }
        }
      }
      if (state.investigation?.state === "searching"
        && !state.environments.some((environment) => environment.state === "active")
        && lastNewSandboxAtMs !== undefined
        && Date.now() - Math.max(searchingAtMs, lastNewSandboxAtMs) >= 150_000) {
        stall = true;
        stopping = true;
        break;
      }
      const jobs = state.jobs.filter((job) => job.kind === "factory_session");
      if (state.environments.length === envs
        && jobs.length >= envs
        && jobs.every((job) => ["succeeded", "failed", "cancelled"].includes(job.state))) {
        stopping = true;
        break;
      }
    }
    stopping = true;
  };

  const pollDaytona = async () => {
    while (!stopping && Date.now() < deadline) {
      const { listForksafe } = await import("../lib/daytona.mjs");
      maxDaytonaSandboxes = Math.max(maxDaytonaSandboxes, (await listForksafe()).length);
      await sleep(5_000);
    }
  };

  try {
    await Promise.all([turnSampler(), pollSnapshots(), pollDaytona()]);
  } catch (error) {
    runnerError = error;
    stopping = true;
  }
  if (!latestSnapshot) latestSnapshot = await snapshot(ctx.investigationId);
  const sessionsByEnvironment = new Map(latestSnapshot.environments.map((environment) => [
    environment.appId,
    latestSnapshot.sessions.filter((session) => session.environmentId === environment.appId),
  ]));
  const totalTokens = latestSnapshot.sessions.reduce((sum, session) => sum + tokenCount(session), 0);
  ctx.tokens = totalTokens;
  ctx.unknownUsageTurns = latestSnapshot.sessions.reduce(
    (sum, session) => sum + (Number(session.usageUnknownTurns) || 0), 0,
  );
  const sessionsEvidence = latestSnapshot.environments.map((environment) => {
    const sessions = sessionsByEnvironment.get(environment.appId) ?? [];
    const vendorIds = new Set(sessions.map((session) => session.factorySession?.id).filter(Boolean));
    return { environmentId: environment.appId, sessionCount: sessions.length, distinctFactorySessionIds: vendorIds.size, sessions };
  });
  const hadRunner = runnersByEnvironment.size > 0;
  if (hadRunner) {
    ctx.checks.check(
      "S1",
      "each environment has at most two session rows and vendor Factory sessions",
      sessionsEvidence.every((item) => item.sessionCount <= 2 && item.distinctFactorySessionIds <= 2),
      sessionsEvidence,
    );
    ctx.checks.check(
      "S2",
      "global active model turns never exceed four",
      maxActiveTurns <= 4,
      { maxActiveTurns, maxModelTurnReservations: maxModelReservations, samples: turnSamples },
    );
  } else {
    ctx.checks.notReached("S1", "session creation and vendor session count stays bounded", "no runner ever started", { sessionsEvidence });
    ctx.checks.notReached("S2", "active model turn concurrency stays at four or fewer", "no runner ever started", { maxActiveTurns, maxModelTurnReservations: maxModelReservations });
  }
  ctx.checks.check(
    "S3",
    "sandbox reservations and Daytona ForkSafe sandboxes never exceed five",
    maxSandboxReservations <= 5 && maxDaytonaSandboxes <= 5,
    { maxSandboxReservations, maxDaytonaSandboxes, snapshots: snapshotSummaries },
  );
  const sandboxErrors = latestSnapshot.sandboxOps.filter((op) => op.status === "error");
  const environmentErrors = latestSnapshot.environments.filter((environment) => environment.state === "error");
  const observedSandboxErrors = snapshotSummaries.flatMap((item) =>
    item.sandboxOps.filter((op) => op.status === "error"));
  const observedEnvironmentErrors = snapshotSummaries.flatMap((item) =>
    item.environments.filter((environment) => environment.state === "error"));
  const allEnvironmentsProvisioned = latestSnapshot.environments.length === envs
    && latestSnapshot.environments.every((environment) => runnerOpsSeen.has(environment.appId) && everActive.has(environment.appId));
  ctx.checks.check(
    "S4",
    "provisioning queues without errors, stalls, or missing active runner environments",
    !observedSandboxErrors.length
      && !observedEnvironmentErrors.length
      && !sandboxErrors.length
      && !environmentErrors.length
      && !stall
      && allEnvironmentsProvisioned
      && !runnerError,
    {
      sandboxErrors: sandboxErrors.map(({ appId, status, lastError }) => ({ appId, status, lastError })),
      sandboxOps: latestSnapshot.sandboxOps.map(({ appId, status, purpose, environmentId, lastError }) => ({
        appId,
        status,
        purpose,
        environmentId,
        lastError,
      })),
      observedSandboxErrors,
      observedEnvironmentErrors,
      environments: latestSnapshot.environments.map(({ appId, state, lastError }) => ({ appId, state, lastError })),
      runnerOpsSeen: [...runnerOpsSeen],
      everActive: [...everActive],
      stall,
      workflowId: latestSnapshot.investigation?.workflowId ?? ctx.captureResponse?.workflowId ?? null,
      runnerError: runnerError ? String(runnerError.message ?? runnerError) : null,
    },
  );
  if (hadRunner) {
    const sessionBudgets = latestSnapshot.sessions.map((session) => ({
      sessionId: session.appId,
      environmentId: session.environmentId,
      turns: session.turns ?? 0,
      state: session.state,
      tokenUsage: session.tokenUsage,
      unknownUsageTurns: session.usageUnknownTurns ?? 0,
      tokens: tokenCount(session),
      passed: (session.turns ?? 0) < 1
        || ((session.turns ?? 0) <= 1 && ["budget_exhausted", "idle", "closed"].includes(session.state)),
    }));
    ctx.checks.check(
      "S5",
      "each session uses at most one turn and closes in an allowed state",
      sessionBudgets.every((item) => item.passed),
      { sessions: sessionBudgets, totalTokens, unknownUsageTurns: ctx.unknownUsageTurns },
    );
  } else {
    ctx.checks.notReached("S5", "session turn and token budgets are bounded", "no runner ever started", { sessions: latestSnapshot.sessions, totalTokens });
  }
  if (snapshotCadenceMs.length) {
    ctx.evidence.snapshotCadenceMs = snapshotCadenceMs;
    ctx.evidence.snapshotSummaries = snapshotSummaries;
    ctx.evidence.turnSamples = turnSamples;
  }
}
