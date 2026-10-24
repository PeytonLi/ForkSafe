import { envGet } from "./convex.mjs";
import { listForksafe } from "./daytona.mjs";
import { capture, credentialFor, globalSnapshot, snapshot, waitFor } from "./investigation.mjs";

export async function preflight(ctx, neededSlots) {
  const launchMode = await envGet("RUNNER_LAUNCH_MODE");
  if (launchMode !== "external") {
    ctx.checks.notReached(
      "PREFLIGHT",
      "external runner mode is enabled before capture",
      "RUNNER_LAUNCH_MODE is not external; refusing to create a capture that could start an unmanaged Factory runner",
      { launchMode: launchMode || null, neededSlots },
    );
    return false;
  }
  const serviceToken = await envGet("INTEGRATION_SHARED_SECRET");
  if (!serviceToken) {
    ctx.checks.notReached("PREFLIGHT", "Convex service token is available", "INTEGRATION_SHARED_SECRET is unset");
    return false;
  }
  let lastState;
  const available = await waitFor(async () => {
    const global = await globalSnapshot();
    lastState = { ...global, neededSlots, forksafeDaytonaSandboxes: (await listForksafe()).length };
    ctx.preflight = lastState;
    return global.activeSandboxReservationCount + neededSlots <= 5;
  }, { timeoutMs: 10 * 60_000, intervalMs: 5_000 });
  if (!available) {
    ctx.checks.notReached(
      "PREFLIGHT",
      "global sandbox reservations plus this scenario fit within capacity five",
      "capacity did not become available within ten minutes",
      lastState ?? { neededSlots },
    );
    return false;
  }
  ctx.checks.check(
    "PREFLIGHT",
    "global sandbox reservations plus this scenario fit within capacity five",
    true,
    lastState,
  );
  return true;
}

export async function captureInvestigation(ctx, envs, timeoutMs = 8 * 60_000) {
  const result = await capture({ title: "", envs, runId: ctx.runId, scenario: ctx.scenario });
  ctx.captureResponse = result;
  if (!result?.accepted || !result.investigationId) {
    ctx.checks.check("CAPTURE", "hosted Convex capture is accepted", false, result ?? { error: "empty response" });
    return null;
  }
  ctx.investigationId = result.investigationId;
  ctx.ids.investigationId = result.investigationId;
  ctx.checks.check("CAPTURE", "hosted Convex capture is accepted", true, { investigationId: result.investigationId });
  const environments = await waitFor(async () => {
    const state = await snapshot(result.investigationId);
    if (!state.investigation) return null;
    if (state.investigation.state === "failed" || state.investigation.captureStatus === "failed") return { failed: true, state };
    if (state.environments.length === envs && state.environments.every((environment) => environment.state === "active")) {
      const credentials = await Promise.all(state.environments.map((environment) => credentialFor(environment.appId)));
      if (credentials.every(Boolean)) {
        return {
          state,
          environments: state.environments,
          credentials: credentials.map((credential) => ({ ...credential, investigationId: result.investigationId })),
        };
      }
    }
    return null;
  }, { timeoutMs, intervalMs: 3_000 });
  if (!environments || environments.failed) {
    ctx.checks.check(
      "ENVIRONMENTS_ACTIVE",
      "all requested environments become active with runner credentials",
      false,
      environments?.state
        ? { environments: environments.state.environments.map(({ appId, state, lastError }) => ({ appId, state, lastError })) }
        : { timeoutMs },
    );
    return null;
  }
  ctx.checks.check(
    "ENVIRONMENTS_ACTIVE",
    "all requested environments become active with runner credentials",
    true,
    { environmentIds: environments.environments.map((environment) => environment.appId) },
  );
  return environments;
}

export async function currentSnapshot(ctx) {
  if (!ctx.investigationId) return null;
  return await snapshot(ctx.investigationId);
}

export function terminalJobState(state) {
  return ["succeeded", "failed", "cancelled"].includes(state);
}
