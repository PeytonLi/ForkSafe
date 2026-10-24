"use node";

import { ConvexError, v } from "convex/values";
import { Daytona } from "@daytonaio/sdk";
import type { VendorRef } from "@forksafe/contracts";
import { CloudDaytonaProvider, loadDaytonaConfig } from "@forksafe/daytona";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { classifyExperiment } from "./lib/experimentStatus.js";

/** Runs simulator cases inside Daytona execution sandboxes. Convex never runs
 *  physics itself; it ships the pinned simulator bundle plus one controller
 *  into the sandbox, executes `python -m simulator.cli`, and pulls results. */

const SIM_ROOT = "/workspace/sim";
const RUN_ROOT = "/workspace/runs";

function provider(): CloudDaytonaProvider {
  const config = loadDaytonaConfig();
  if (config.mode !== "cloud" || !config.apiKey) throw new ConvexError("daytona_cloud_provider_blocked");
  return new CloudDaytonaProvider(new Daytona({ apiKey: config.apiKey, apiUrl: config.apiUrl }), config);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function readyRef(ctx: any, sandboxOpId: string): Promise<{ ref: VendorRef; op: any }> {
  const op = await ctx.runQuery(internal.sandboxes.getSandboxOp, { sandboxOpId });
  if (!op || op.status !== "ready" || !op.sandbox) throw new ConvexError("sandbox_not_ready");
  return { ref: op.sandbox as VendorRef, op };
}

/** Uploads and extracts the simulator bundle once per sandbox. */
export const ensureSimBundle = internalAction({
  args: { sandboxOpId: v.string() },
  handler: async (ctx, args): Promise<{ ready: boolean; bundleSha256?: string; assetsSha256?: string; detail?: string }> => {
    const { ref, op } = await readyRef(ctx, args.sandboxOpId);
    const bundle = await ctx.runQuery(internal.bundles.get, { key: "simulator" });
    if (!bundle) throw new ConvexError("simulator_bundle_missing");
    if (op.bundleSha256 === bundle.sha256) return { ready: true, bundleSha256: bundle.sha256 };
    const blob = await ctx.storage.get(bundle.storageId);
    if (!blob) throw new ConvexError("simulator_bundle_missing");
    const daytona = provider();
    await daytona.uploadFile(ref, "/workspace/sim.tar", new Uint8Array(await blob.arrayBuffer()));
    const extract = await daytona.exec(ref, { command: `python3 -m tarfile -e /workspace/sim.tar ${SIM_ROOT}`, cwd: "/workspace", timeoutSec: 120 });
    if (extract.exitCode !== 0) throw new ConvexError("simulator_bundle_extract_failed");
    const preflight = await daytona.exec(ref, {
      command: `python3 ${SIM_ROOT}/forksafe_preflight.py`, cwd: SIM_ROOT,
      env: { PYTHONPATH: `${SIM_ROOT}/services` }, timeoutSec: 120,
    });
    if (preflight.exitCode !== 0) {
      return { ready: false, detail: preflight.output.slice(-400) };
    }
    const parsed = JSON.parse(preflight.output.trim().split("\n").at(-1) ?? "{}") as { assetsSha256?: string };
    await ctx.runMutation(internal.sandboxes.markBundleReady, { sandboxOpId: args.sandboxOpId, bundleSha256: bundle.sha256 });
    return { ready: true, bundleSha256: bundle.sha256, assetsSha256: parsed.assetsSha256 };
  },
});

const simCase = v.object({
  caseId: v.string(), suite: v.union(v.literal("original"), v.literal("public"), v.literal("withheld")),
  seed: v.number(), sceneOverrides: v.record(v.string(), v.number()), description: v.optional(v.string()),
});

export type CaseRunOutcome = {
  ok: boolean;
  exitCode: number;
  result?: Record<string, unknown>;
  status: "succeeded" | "physics_failure" | "constraint_violation" | "engine_error" | "invalid";
  failureKinds: string[];
  completed: boolean;
  completionTimeSec?: number;
  firstFailure?: { kind: string; tSec: number; detail: string };
  engineVersion: string;
  assetsSha256: string;
  controllerSha256: string;
  traceArtifactId?: string;
  replayArtifactId?: string;
  replayBytes?: number;
  logTail: string;
  wallMs: number;
};

/** Executes one case. The controller is written fresh per run; artifacts are
 *  stored in Convex file storage and registered (visibility by suite). */
export const runCase = internalAction({
  args: {
    sandboxOpId: v.string(),
    investigationId: v.string(),
    attemptId: v.string(),
    experimentId: v.string(),
    simCase,
    controllerSource: v.string(),
    timeoutSec: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CaseRunOutcome> => {
    const started = Date.now();
    const { ref } = await readyRef(ctx, args.sandboxOpId);
    const ensured = await ctx.runAction(internal.execution.ensureSimBundle, { sandboxOpId: args.sandboxOpId });
    if (!ensured.ready) throw new ConvexError("simulator_bundle_not_ready");
    const daytona = provider();
    const runDir = `${RUN_ROOT}/${args.experimentId}`;
    const encoder = new TextEncoder();
    await daytona.uploadFile(ref, `${runDir}/controller/task_controller.py`, encoder.encode(args.controllerSource));
    await daytona.uploadFile(ref, `${runDir}/case.json`, encoder.encode(JSON.stringify({
      caseId: args.simCase.caseId, suite: args.simCase.suite, seed: args.simCase.seed,
      sceneOverrides: args.simCase.sceneOverrides, ...(args.simCase.description ? { description: args.simCase.description } : {}),
    })));
    const timeoutSec = Math.min(60, Math.max(1, args.timeoutSec ?? 30));
    const command = [
      "python3 -m simulator.cli",
      `--controller-dir ${runDir}/controller`,
      `--case-json ${runDir}/case.json`,
      `--seed ${Math.trunc(args.simCase.seed)}`,
      `--out-dir ${runDir}/out`,
      `--experiment-id ${args.experimentId}`,
      `--timeout-sec ${timeoutSec}`,
    ].join(" ");
    const run = await daytona.exec(ref, {
      command, cwd: SIM_ROOT, timeoutSec: timeoutSec * 4 + 60,
      env: { PYTHONPATH: `${SIM_ROOT}/services`, PYTHONDONTWRITEBYTECODE: "1", HOME: runDir, TMPDIR: runDir },
    });
    const expectedSha = await sha256(encoder.encode(args.controllerSource));
    let resultBytes: Uint8Array | undefined;
    let traceBytes: Uint8Array | undefined;
    try {
      resultBytes = await daytona.downloadFile(ref, `${runDir}/out/result.json`);
      traceBytes = await daytona.downloadFile(ref, `${runDir}/out/trace.json`);
    } catch {
      resultBytes = undefined;
    }
    const base = {
      ok: false, exitCode: run.exitCode, logTail: run.output.slice(-2000), wallMs: Date.now() - started,
      engineVersion: "unknown", assetsSha256: "0".repeat(64), controllerSha256: expectedSha,
    };
    if (!resultBytes) {
      return { ...base, status: "invalid", failureKinds: ["missing_artifact"], completed: false };
    }
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(new TextDecoder().decode(resultBytes)) as Record<string, unknown>;
    } catch {
      return { ...base, status: "invalid", failureKinds: ["invalid_run"], completed: false };
    }
    const failureKinds = Array.isArray(result.failureKinds) ? (result.failureKinds as string[]) : ["invalid_run"];
    const completed = result.completed === true;
    const controllerSha256 = typeof result.controllerSha256 === "string" ? result.controllerSha256 : expectedSha;
    const shaMismatch = controllerSha256 !== expectedSha && !failureKinds.includes("invalid_run");
    const status = shaMismatch ? "invalid" : classifyExperiment({ completed, failureKinds });
    const store = async (bytes: Uint8Array, kind: "replay" | "trace") => {
      if (bytes.byteLength > 8 * 1024 * 1024) return undefined;
      const storageId = await ctx.storage.store(new Blob([bytes as BlobPart]));
      const inserted = await ctx.runMutation(internal.artifacts.insertCloudArtifact, {
        kind, sha256: await sha256(bytes), bytes: bytes.byteLength, investigationId: args.investigationId,
        attemptId: args.attemptId, visibility: args.simCase.suite === "withheld" ? "withheld" : "internal", storageId,
      });
      return inserted.artifactId as string;
    };
    const replayArtifactId = await store(resultBytes, "replay");
    const traceArtifactId = traceBytes ? await store(traceBytes, "trace") : undefined;
    if (replayArtifactId && args.simCase.suite !== "withheld") {
      await ctx.runMutation(internal.artifacts.saveReplay, {
        artifactId: replayArtifactId, experimentId: args.experimentId, investigationId: args.investigationId,
        visibility: "internal", result: { ...result, experimentId: args.experimentId },
      });
    }
    return {
      ...base,
      ok: status === "succeeded",
      result: { ...result, frames: undefined },
      status,
      failureKinds: shaMismatch ? [...failureKinds, "invalid_run"] : failureKinds,
      completed,
      ...(typeof result.completionTimeSec === "number" ? { completionTimeSec: result.completionTimeSec } : {}),
      ...(result.firstFailure && typeof result.firstFailure === "object" ? { firstFailure: result.firstFailure as CaseRunOutcome["firstFailure"] } : {}),
      engineVersion: typeof result.engineVersion === "string" ? result.engineVersion : "unknown",
      assetsSha256: typeof result.assetsSha256 === "string" ? result.assetsSha256 : "0".repeat(64),
      controllerSha256,
      ...(traceArtifactId ? { traceArtifactId } : {}),
      ...(replayArtifactId ? { replayArtifactId, replayBytes: resultBytes.byteLength } : {}),
    };
  },
});

/** Ships the runner bundle into a trusted runner sandbox and starts it with a
 *  scoped credential. The runner never receives the deploy key or bridge secret. */
export const launchRunner = internalAction({
  args: {
    sandboxOpId: v.string(),
    environmentId: v.string(),
    investigationId: v.string(),
    credentialId: v.string(),
    secret: v.string(),
    convexSiteUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{ launched: boolean; commandId?: string; detail?: string }> => {
    const { ref } = await readyRef(ctx, args.sandboxOpId);
    const bundle = await ctx.runQuery(internal.bundles.get, { key: "runner" });
    if (!bundle) throw new ConvexError("runner_bundle_missing");
    const blob = await ctx.storage.get(bundle.storageId);
    if (!blob) throw new ConvexError("runner_bundle_missing");
    const daytona = provider();
    await daytona.uploadFile(ref, "/workspace/runner/runner.mjs", new Uint8Array(await blob.arrayBuffer()));
    const factoryKey = process.env.FACTORY_API_KEY;
    const handle = await daytona.startCommand(ref, {
      command: "node /workspace/runner/runner.mjs",
      cwd: "/workspace/runner",
      env: {
        RUNNER_JOB_SOURCE_URL: args.convexSiteUrl,
        RUNNER_CONTROL_URL: args.convexSiteUrl,
        RUNNER_CALLBACK_SECRET: args.secret,
        RUNNER_CREDENTIAL_ID: args.credentialId,
        RUNNER_ENVIRONMENT_ID: args.environmentId,
        RUNNER_INVESTIGATION_ID: args.investigationId,
        RUNNER_WORKER_ID: `runner-${args.environmentId.slice(0, 8)}`,
        RUNNER_WORKSPACE_ROOT: "/workspace/agent",
        RUNNER_JOBS_DIR: "/workspace/runner/var",
        FACTORY_MODE: factoryKey ? "cloud" : "fixture",
        ...(factoryKey ? { FACTORY_API_KEY: factoryKey } : {}),
        ...(process.env.FACTORY_MODEL ? { FACTORY_MODEL: process.env.FACTORY_MODEL } : {}),
        MAX_ACTIVE_MODEL_CALLS: "2",
        PATH: "/home/forksafe/.local/bin:/usr/local/bin:/usr/bin:/bin",
      },
    });
    await ctx.runMutation(internal.sandboxData.saveCommand, {
      sandboxOpId: args.sandboxOpId, jobId: args.environmentId, attemptId: args.credentialId, epoch: 0,
      command: "node /workspace/runner/runner.mjs", handle,
    });
    return { launched: true, commandId: handle.commandId };
  },
});

/** Tails the runner process log for diagnostics (bounded). */
export const runnerLogTail = internalAction({
  args: { sandboxOpId: v.string(), handle: v.object({ sessionId: v.string(), commandId: v.string() }) },
  handler: async (ctx, args): Promise<{ done: boolean; exitCode?: number; logs: string }> => {
    const { ref } = await readyRef(ctx, args.sandboxOpId);
    const result = await provider().pollCommand(ref, args.handle, { maxBytes: 16_384 });
    return { done: result.done, ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), logs: result.logs };
  },
});
