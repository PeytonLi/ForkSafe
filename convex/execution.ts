"use node";

import { ConvexError, v } from "convex/values";
import { Daytona } from "@daytonaio/sdk";
import type { VendorRef } from "@forksafe/contracts";
import { CloudDaytonaProvider, loadDaytonaConfig } from "@forksafe/daytona";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { classifyExperiment } from "./lib/experimentStatus.js";
import { signedCaseCommand } from "./lib/evaluatorBackend.js";
import withheldManifest from "../evaluation/withheld/manifest.json";
import manifestsLock from "../evaluation/manifests.lock.json";

/** Runs simulator cases inside Daytona execution sandboxes. Convex never runs
 *  physics itself; it ships the pinned simulator bundle plus one controller
 *  into the sandbox, executes `python -m simulator.cli`, and pulls results. */

const SIM_ROOT = "/workspace/sim";
const RUN_ROOT = "/workspace/runs";
const SIM_PYTHONPATH = `${SIM_ROOT}/services:${SIM_ROOT}/pydeps`;

// File transfer runs fixed Python snippets through the Daytona SDK's executeCommand directly: the SDK's
// multipart upload (fs.uploadFile, and codeRun which uses it) fails inside the Convex Node runtime with
// "BadHeader content-type", and the provider's shell policy rejects the quoting these snippets need.
// Inputs are validated against strict allowlists before being interpolated and only sandboxes this
// control plane created (forksafe.purpose label) are touched. Bundles are pulled straight from Convex
// storage so 37 MB tars never enter the action's memory budget.
const PY_WRITE_B64 = "import base64,pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(base64.b64decode(sys.argv[2]))";
const PY_FETCH = "import pathlib,sys,urllib.request; p=pathlib.Path(sys.argv[2]); p.parent.mkdir(parents=True, exist_ok=True); urllib.request.urlretrieve(sys.argv[1], p); print(p.stat().st_size)";
// Runner sandboxes (forksafe-runner-v1) ship node but no python.
const JS_WRITE_B64 = "const [p,b]=process.argv.slice(1);const fs=require(\"fs\");fs.mkdirSync(require(\"path\").dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(b,\"base64\"))";
const JS_FETCH = "const [u,p]=process.argv.slice(1);const fs=require(\"fs\");fetch(u).then(r=>{if(!r.ok)throw new Error(String(r.status));return r.arrayBuffer()}).then(b=>{fs.mkdirSync(require(\"path\").dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(b));console.log(b.byteLength)}).catch(e=>{console.error(e.message);process.exit(1)})";
const SAFE_REMOTE_PATH = /^\/workspace\/[A-Za-z0-9._\/-]+$/;
const SAFE_BASE64 = /^[A-Za-z0-9+/=]*$/;
const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/?=&%-]*$/;

type TrustedSandbox = { sandbox: Awaited<ReturnType<Daytona["get"]>>; purpose: "execution" | "runner" | "evaluator" };

async function trustedSandbox(ref: VendorRef): Promise<TrustedSandbox> {
  const config = loadDaytonaConfig();
  if (config.mode !== "cloud" || !config.apiKey) throw new ConvexError("daytona_cloud_provider_blocked");
  const sandbox = await new Daytona({ apiKey: config.apiKey, apiUrl: config.apiUrl }).get(ref.id);
  const purpose = sandbox.labels["forksafe.purpose"];
  if (purpose !== "execution" && purpose !== "runner" && purpose !== "evaluator") throw new ConvexError("sandbox_not_owned");
  return { sandbox, purpose };
}

async function trustedExec(trusted: TrustedSandbox, command: string, timeoutSec: number): Promise<{ exitCode: number; output: string }> {
  try {
    const result = await trusted.sandbox.process.executeCommand(command, "/workspace", undefined, timeoutSec);
    return { exitCode: result.exitCode ?? 1, output: (result.result ?? "").slice(-2000) };
  } catch (error) {
    throw new ConvexError(`daytona_exec_failed:${error instanceof Error ? error.name : "unknown"}`);
  }
}

async function putSmallFile(_daytona: unknown, ref: VendorRef, remotePath: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 96_000) throw new ConvexError("file_too_large_for_inline_transfer");
  // The inline writer takes the payload as argv; an empty payload drops the argument and fails remotely.
  if (bytes.byteLength === 0) throw new ConvexError("file_transfer_empty");
  const encoded = Buffer.from(bytes).toString("base64");
  if (!SAFE_REMOTE_PATH.test(remotePath) || !SAFE_BASE64.test(encoded)) throw new ConvexError("file_transfer_input_rejected");
  const trusted = await trustedSandbox(ref);
  const command = trusted.purpose === "runner" ? `node -e '${JS_WRITE_B64}' ${remotePath} ${encoded}` : `python3 -c '${PY_WRITE_B64}' ${remotePath} ${encoded}`;
  const result = await trustedExec(trusted, command, 60);
  if (result.exitCode !== 0) throw new ConvexError(`file_write_failed:${remotePath}`);
}

// Artifact pull: the sandbox POSTs the file to a one-shot Convex storage upload URL (write-only,
// single use) and Convex reads it back from storage. sandbox.fs.downloadFile from the Convex Node
// runtime failed intermittently on ~0.5 MB files, so it is only the fallback.
// No single quotes inside: the snippet is wrapped in single quotes on the sandbox shell.
const PY_PUSH = "import sys,urllib.request; r=urllib.request.Request(sys.argv[1], data=open(sys.argv[2],\"rb\").read(), headers={\"Content-Type\":\"application/json\"}, method=\"POST\"); print(urllib.request.urlopen(r, timeout=120).read().decode())";
const JS_PUSH = "const [u,p]=process.argv.slice(1);const fs=require(\"fs\");fetch(u,{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:fs.readFileSync(p)}).then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e.message);process.exit(1)})";

async function pullFile(ctx: { runMutation: Function; storage: { get: Function; delete: Function } }, daytona: { downloadFile: Function }, ref: VendorRef, remotePath: string): Promise<Uint8Array> {
  if (!SAFE_REMOTE_PATH.test(remotePath)) throw new ConvexError("file_transfer_input_rejected");
  try {
    const uploadUrl = (await ctx.runMutation(internal.bundles.createUploadUrl, {})) as string;
    if (!SAFE_URL.test(uploadUrl)) throw new ConvexError("upload_url_rejected");
    const trusted = await trustedSandbox(ref);
    const command = trusted.purpose === "runner" ? `node -e '${JS_PUSH}' '${uploadUrl}' ${remotePath}` : `python3 -c '${PY_PUSH}' '${uploadUrl}' ${remotePath}`;
    const result = await trustedExec(trusted, command, 180);
    const match = /"storageId"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(result.output);
    if (result.exitCode !== 0 || !match) throw new ConvexError(`artifact_push_failed:${remotePath}`);
    const storageId = match[1];
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new ConvexError("artifact_storage_missing");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await ctx.storage.delete(storageId);
    return bytes;
  } catch (error) {
    console.log("pullFile:storage_path_failed", remotePath, error instanceof Error ? error.message.slice(0, 160) : "unknown");
    return (await daytona.downloadFile(ref, remotePath)) as Uint8Array;
  }
}

async function fetchToFile(_daytona: unknown, ref: VendorRef, url: string, remotePath: string): Promise<void> {
  if (!SAFE_REMOTE_PATH.test(remotePath) || !SAFE_URL.test(url)) throw new ConvexError("file_transfer_input_rejected");
  const trusted = await trustedSandbox(ref);
  const command = trusted.purpose === "runner" ? `node -e '${JS_FETCH}' '${url}' ${remotePath}` : `python3 -c '${PY_FETCH}' '${url}' ${remotePath}`;
  const result = await trustedExec(trusted, command, 300);
  if (result.exitCode !== 0) throw new ConvexError(`file_fetch_failed:${remotePath}:${result.output.slice(-120)}`);
}

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
    const bundleUrl = await ctx.storage.getUrl(bundle.storageId);
    if (!bundleUrl) throw new ConvexError("simulator_bundle_missing");
    const daytona = provider();
    await fetchToFile(daytona, ref, bundleUrl, "/workspace/sim.tar");
    // Extraction is idempotent, so one retry absorbs a transient sandbox exec failure.
    let extract = await daytona.exec(ref, { command: `python3 -m tarfile -e /workspace/sim.tar ${SIM_ROOT}`, cwd: "/workspace", timeoutSec: 120 });
    if (extract.exitCode !== 0) {
      console.log("ensureSimBundle:extract_retry", extract.exitCode, extract.output.slice(-160));
      extract = await daytona.exec(ref, { command: `python3 -m tarfile -e /workspace/sim.tar ${SIM_ROOT}`, cwd: "/workspace", timeoutSec: 120 });
    }
    if (extract.exitCode !== 0) throw new ConvexError("simulator_bundle_extract_failed");
    // forksafe-exec-v1 ships mujoco+numpy only; the simulator also imports pydantic, so install it into
    // a bundle-local target dir (deterministic regardless of HOME) until the execution image adds it.
    const deps = await daytona.exec(ref, {
      command: `python3 -m pip install --quiet --no-cache-dir --target ${SIM_ROOT}/pydeps pydantic==2.14.1`,
      cwd: SIM_ROOT, env: { PYTHONPATH: SIM_PYTHONPATH }, timeoutSec: 180,
    });
    if (deps.exitCode !== 0) return { ready: false, detail: `pydeps_install_failed:${deps.output.slice(-300)}` };
    const preflight = await daytona.exec(ref, {
      command: `python3 ${SIM_ROOT}/forksafe_preflight.py`, cwd: SIM_ROOT,
      env: { PYTHONPATH: SIM_PYTHONPATH }, timeoutSec: 120,
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
    console.log("runCase:stage", "ensure_bundle", args.experimentId);
    const ensured = await ctx.runAction(internal.execution.ensureSimBundle, { sandboxOpId: args.sandboxOpId });
    if (!ensured.ready) throw new ConvexError("simulator_bundle_not_ready");
    const daytona = provider();
    const runDir = `${RUN_ROOT}/${args.experimentId}`;
    const encoder = new TextEncoder();
    console.log("runCase:stage", "put_controller", args.experimentId);
    await putSmallFile(daytona, ref, `${runDir}/controller/task_controller.py`, encoder.encode(args.controllerSource));
    console.log("runCase:stage", "put_case", args.experimentId);
    await putSmallFile(daytona, ref, `${runDir}/case.json`, encoder.encode(JSON.stringify({
      caseId: args.simCase.caseId, suite: args.simCase.suite, seed: args.simCase.seed,
      sceneOverrides: args.simCase.sceneOverrides, ...(args.simCase.description ? { description: args.simCase.description } : {}),
    })));
    console.log("runCase:stage", "exec_simulator", args.experimentId);
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
    let run: { exitCode: number; output: string };
    try {
      run = await daytona.exec(ref, {
        command, cwd: SIM_ROOT, timeoutSec: timeoutSec * 4 + 60,
        env: { PYTHONPATH: SIM_PYTHONPATH, PYTHONDONTWRITEBYTECODE: "1", HOME: runDir, TMPDIR: runDir },
      });
    } catch (error) {
      run = { exitCode: -1, output: `exec_failed:${error instanceof Error ? error.message : "unknown"}` };
    }
    const expectedSha = await sha256(encoder.encode(args.controllerSource));
    let resultBytes: Uint8Array | undefined;
    let traceBytes: Uint8Array | undefined;
    try {
      resultBytes = await pullFile(ctx, daytona, ref, `${runDir}/out/result.json`);
      traceBytes = await pullFile(ctx, daytona, ref, `${runDir}/out/trace.json`);
    } catch (error) {
      console.log("runCase:artifact_pull_failed", args.experimentId, error instanceof Error ? error.message.slice(0, 200) : "unknown");
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
      const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/json" }));
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
    const bundleUrl = await ctx.storage.getUrl(bundle.storageId);
    if (!bundleUrl) throw new ConvexError("runner_bundle_missing");
    const daytona = provider();
    await fetchToFile(daytona, ref, bundleUrl, "/workspace/runner/runner.mjs");
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
        HOME: "/home/forksafe",
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The withheld manifest is not baked into the image; it is uploaded per run and
 *  consumed (deleted) by run_candidate once read. Bytes must match the lock. */
async function withheldManifestBytes(): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(withheldManifest, null, 2)}\n`);
  if (await sha256(bytes) !== manifestsLock.withheld) throw new ConvexError("withheld_manifest_lock_mismatch");
  return bytes;
}

/** Runs one case through PR #13's `evaluator.run_candidate` inside a v3 evaluator
 *  sandbox. The sandbox signs the result with the seed injected at create time;
 *  this action only returns the document, Convex verifies before scoring. */
export const runSignedCase = internalAction({
  args: {
    sandboxOpId: v.string(), investigationId: v.string(), candidateId: v.string(), attemptId: v.string(),
    caseId: v.string(), suite: v.union(v.literal("public"), v.literal("withheld")),
    controllerSource: v.string(), controllerSha256: v.string(),
  },
  handler: async (ctx, args): Promise<{ exitCode: number; document: unknown; logTail: string; wallMs: number }> => {
    const started = Date.now();
    for (const id of [args.investigationId, args.candidateId, args.attemptId]) {
      if (!UUID_RE.test(id)) throw new ConvexError("signed_case_input_rejected");
    }
    if (!CASE_ID_RE.test(args.caseId) || !/^[0-9a-f]{64}$/.test(args.controllerSha256)) throw new ConvexError("signed_case_input_rejected");
    const { ref } = await readyRef(ctx, args.sandboxOpId);
    const daytona = provider();
    const runDir = `${RUN_ROOT}/eval-${args.attemptId}/${args.caseId}`;
    await putSmallFile(daytona, ref, `${runDir}/controller/task_controller.py`, new TextEncoder().encode(args.controllerSource));
    if (args.suite === "withheld") await putSmallFile(daytona, ref, `${runDir}/withheld-manifest.json`, await withheldManifestBytes());
    await putSmallFile(daytona, ref, `${runDir}/work/.keep`, new Uint8Array([10]));
    const command = signedCaseCommand({ ...args, runDir });
    let run: { exitCode: number; output: string };
    try {
      run = await daytona.exec(ref, { command, cwd: "/workspace", timeoutSec: 300 });
    } catch (error) {
      run = { exitCode: -1, output: `exec_failed:${error instanceof Error ? `${error.name}:${error.message.slice(0, 120)}` : "unknown"}` };
      console.log("runSignedCase:exec_failed", args.caseId, run.output);
    }
    let document: unknown = null;
    try {
      const bytes = await pullFile(ctx, daytona, ref, `${runDir}/result.json`);
      if (bytes.byteLength <= 2 * 1024 * 1024) document = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      document = null;
    }
    return { exitCode: run.exitCode, document, logTail: run.output.slice(-600), wallMs: Date.now() - started };
  },
});
