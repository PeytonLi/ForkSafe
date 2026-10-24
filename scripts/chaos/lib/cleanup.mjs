import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { byInvestigation, isGone, listForksafe } from "./daytona.mjs";
import { inlineQuery, redactSecrets } from "./convex.mjs";
import { cancel, snapshot, waitFor } from "./investigation.mjs";
import { isProcessGroupAlive, kill, listRunnerRecordFiles } from "./runners.mjs";

const terminalStates = new Set(["completed", "failed", "cancelled"]);
const terminalSandboxStates = new Set(["terminated", "error"]);

export function selectCleanupInvestigations(investigations) {
  return investigations.filter((item) =>
    typeof item.title === "string"
    && item.title.startsWith("chaos:")
    && !terminalStates.has(item.state));
}

async function stopRunners(runners) {
  const results = [];
  for (const runner of runners) {
    try {
      if (isProcessGroupAlive(runner.pid)) {
        kill(runner, "SIGTERM");
        results.push({ pid: runner.pid, signal: "SIGTERM" });
      }
    } catch (error) {
      results.push({ pid: runner.pid, error: redactSecrets(error?.message ?? error) });
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && runners.some((runner) => isProcessGroupAlive(runner.pid))) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const runner of runners) {
    try {
      if (isProcessGroupAlive(runner.pid)) {
        kill(runner, "SIGKILL");
        results.push({ pid: runner.pid, signal: "SIGKILL" });
      }
    } catch (error) {
      results.push({ pid: runner.pid, error: redactSecrets(error?.message ?? error) });
    }
  }
  return results;
}

async function goneSandboxOps(ops) {
  const outcomes = await Promise.all(ops.map(async (op) => {
    const id = op.sandbox?.id;
    if (!id) return { sandboxOpId: op.appId, sandboxId: null, gone: true };
    return { sandboxOpId: op.appId, sandboxId: id, gone: await isGone(id) };
  }));
  return outcomes;
}

export async function cleanupInvestigation(ctx, investigationId) {
  const runnerResults = await stopRunners(ctx.runners ?? []);
  let initial = null;
  const errors = [];
  let harnessRecovery = null;
  if (ctx.cleanupHook) {
    try {
      harnessRecovery = await ctx.cleanupHook();
    } catch (error) {
      errors.push(redactSecrets(error?.message ?? error));
    }
  }
  try {
    initial = await snapshot(investigationId);
    if (initial.investigation && !terminalStates.has(initial.investigation.state)) {
      await cancel(investigationId);
    }
  } catch (error) {
    errors.push(redactSecrets(error?.message ?? error));
  }
  const final = await waitFor(async () => {
    const state = await snapshot(investigationId);
    const sandboxList = await byInvestigation(investigationId);
    const opGone = await goneSandboxOps(state.sandboxOps);
    const opsTerminal = state.sandboxOps.every((op) => terminalSandboxStates.has(op.status));
    const referencesGone = opGone.every((item) => item.gone);
    if (terminalStates.has(state.investigation?.state)
      && opsTerminal
      && referencesGone
      && sandboxList.length === 0) {
      return { state, sandboxList, opGone };
    }
    return null;
  }, { timeoutMs: 150_000, intervalMs: 3_000 }).catch((error) => {
    errors.push(redactSecrets(error?.message ?? error));
    return null;
  });
  let value = final;
  if (!value) {
    const state = await snapshot(investigationId).catch((error) => {
      errors.push(redactSecrets(error?.message ?? error));
      return initial ?? { investigation: null, sandboxOps: [] };
    });
    const sandboxList = await byInvestigation(investigationId).catch((error) => {
      errors.push(redactSecrets(error?.message ?? error));
      return [];
    });
    let opGone = [];
    try {
      opGone = await goneSandboxOps(state.sandboxOps);
    } catch (error) {
      errors.push(redactSecrets(error?.message ?? error));
    }
    value = { state, sandboxList, opGone };
  }
  const cleanupResult = {
    investigationId,
    investigationState: value.state.investigation?.state ?? null,
    cancelStatus: value.state.investigation?.cancelStatus ?? null,
    sandboxOps: value.state.sandboxOps.map((op) => ({ id: op.appId, status: op.status, lastError: op.lastError })),
    sandboxIdsGone: value.opGone,
    remainingDaytonaSandboxes: value.sandboxList.map((item) => ({ id: item.id, state: item.state })),
    runners: runnerResults,
    harnessRecovery,
    errors,
    complete: value.state.sandboxOps.every((op) => terminalSandboxStates.has(op.status))
      && terminalStates.has(value.state.investigation?.state)
      && value.opGone.every((item) => item.gone)
      && value.sandboxList.length === 0,
  };
  if (ctx) ctx.cleanupResults = [...(ctx.cleanupResults ?? []), cleanupResult];
  return cleanupResult;
}

export async function cleanupScenario(ctx) {
  if (ctx.investigationId) {
    const result = await cleanupInvestigation(ctx, ctx.investigationId);
    ctx.checks.check(
      "CLEANUP",
      "scenario resources are terminal and no Daytona sandboxes remain",
      result.complete,
      result,
    );
    return result;
  }
  ctx.checks.check("CLEANUP", "scenario created no resources requiring cleanup", true, { runnersStopped: true });
  return { complete: true, investigationId: null };
}

async function readRunnerFile(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export async function cleanupAll() {
  const root = join(process.cwd(), "var", "chaos");
  let directories = [];
  try {
    directories = await readdir(root, { withFileTypes: true });
  } catch {
  }
  const runnerPids = [];
  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    const records = await readRunnerFile(join(root, directory.name, "runners.json"));
    for (const runner of records) {
      try {
        if (isProcessGroupAlive(runner.pid)) {
          kill(runner, "SIGTERM");
          runnerPids.push({ pid: runner.pid, signal: "SIGTERM" });
        }
      } catch (error) {
        runnerPids.push({ pid: runner.pid, error: redactSecrets(error?.message ?? error) });
      }
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && runnerPids.some((item) => item.signal === "SIGTERM" && isProcessGroupAlive(item.pid))) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const item of runnerPids.filter((entry) => entry.signal === "SIGTERM")) {
    if (isProcessGroupAlive(item.pid)) {
      kill(item.pid, "SIGKILL");
      runnerPids.push({ pid: item.pid, signal: "SIGKILL" });
    }
  }
  const listedResult = await inlineQuery(`
    const rows = await ctx.db.query("investigations").collect();
    return { rows: rows.map(({ appId, title, state, cancelStatus }) => ({ appId, title, state, cancelStatus })) };
  `);
  const listed = listedResult?.rows ?? [];
  const selected = selectCleanupInvestigations(listed);
  const investigations = [];
  for (const item of selected) {
    investigations.push(await cleanupInvestigation({ runners: [] }, item.appId));
  }
  const sandboxes = await listForksafe();
  return {
    selectedInvestigations: selected.map(({ appId, title, state }) => ({ appId, title, state })),
    investigations,
    runnerPids,
    globalForksafeSandboxCount: sandboxes.length,
    sandboxes: sandboxes.map(({ id, state, labels }) => ({ id, state, investigationId: labels["forksafe.investigation"] })),
    runnerRecordFiles: await listRunnerRecordFiles(root),
  };
}
