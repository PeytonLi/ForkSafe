import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { shouldStartAgents } from "./lib/captureGate.js";
import { appId } from "./lib/validators.js";

/** Records the baseline failure for a captured investigation by really
 *  running the baseline controller in an execution sandbox. Nothing here is
 *  synthesized: if Daytona or the bundle is unavailable the capture fails. */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureExecutionSandbox(ctx: any, investigationId: string, waitMs = 240_000): Promise<any> {
  let op = await ctx.runQuery(internal.sandboxes.readyOperationFor, { investigationId, purpose: "execution" });
  if (!op) {
    const provider = process.env.DAYTONA_MODE === "local" ? "local" : "daytona";
    const requested = await ctx.runMutation(internal.sandboxes.requestSandbox, {
      purpose: "execution", investigationId, snapshot: process.env.DAYTONA_EXECUTION_SNAPSHOT ?? "forksafe-exec-v1",
      resources: { cpu: 2, memoryGiB: 2, diskGiB: 10 }, provider,
    });
    op = await ctx.runQuery(internal.sandboxes.getSandboxOp, { sandboxOpId: requested.sandboxOpId });
  }
  const deadline = Date.now() + waitMs;
  while (op && op.status !== "ready" && Date.now() < deadline) {
    if (["error", "terminated", "terminating"].includes(op.status)) throw new ConvexError("execution_sandbox_failed");
    await sleep(3_000);
    op = await ctx.runQuery(internal.sandboxes.getSandboxOp, { sandboxOpId: op.appId });
  }
  if (!op || op.status !== "ready") throw new ConvexError("execution_sandbox_not_ready");
  return op;
}

export const run = internalAction({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ recorded: boolean; started?: boolean; experimentId?: string; status?: string; error?: string }> => {
    const investigation = await ctx.runQuery(internal.investigations.getByAppId, { investigationId: args.investigationId });
    if (!investigation) throw new ConvexError("investigation_not_found");
    if (investigation.captureStatus === "recorded") return { recorded: true, experimentId: investigation.baselineExperimentId };
    await ctx.runMutation(internal.investigations.setCapture, { investigationId: args.investigationId, captureStatus: "running" });
    try {
      const baselineBundle = await ctx.runQuery(internal.bundles.get, { key: "baseline_controller" });
      const controllerSha256 = investigation.controllerSha256 ?? baselineBundle?.sha256;
      if (!controllerSha256) throw new ConvexError("baseline_controller_missing");
      const source = await ctx.runQuery(internal.evidence.getSourceBySha, { controllerSha256 });
      if (!source) throw new ConvexError(investigation.controllerSha256 ? "controller_source_missing" : "baseline_controller_missing");
      const sandbox = await ensureExecutionSandbox(ctx, args.investigationId);
      const attemptId = appId();
      const experimentId = investigation.baselineExperimentId;
      await ctx.runMutation(internal.evidence.reserveExperiment, {
        experimentId, investigationId: args.investigationId, attemptId, epoch: 0, purpose: "baseline",
        simCase: investigation.baselineCase, controllerSha256, sandboxOpId: sandbox.appId, changedFunctions: [],
      });
      const outcome = await ctx.runAction(internal.execution.runCase, {
        sandboxOpId: sandbox.appId, investigationId: args.investigationId, attemptId, experimentId,
        simCase: investigation.baselineCase, controllerSource: source.source, timeoutSec: 30,
      });
      const simulatorStopped = outcome.failureKinds.includes("invalid_run") || outcome.failureKinds.includes("missing_artifact");
      if (!simulatorStopped && outcome.controllerSha256 !== controllerSha256) {
        await ctx.runMutation(internal.evidence.finishExperiment, {
          experimentId, status: "invalid", failureKinds: ["controller_sha_mismatch"], completed: false,
          engineVersion: outcome.engineVersion, assetsSha256: outcome.assetsSha256,
          controllerSha256: outcome.controllerSha256, spacetimeCommitted: false,
          ...(outcome.traceArtifactId ? { traceArtifactId: outcome.traceArtifactId } : {}),
          ...(outcome.replayArtifactId ? { replayArtifactId: outcome.replayArtifactId } : {}),
        });
        await ctx.runMutation(internal.investigations.setCapture, {
          investigationId: args.investigationId, captureStatus: "failed", error: "controller_sha_mismatch",
        });
        return { recorded: false, experimentId, error: "controller_sha_mismatch" };
      }
      await ctx.runMutation(internal.evidence.finishExperiment, {
        experimentId, status: outcome.status, failureKinds: outcome.failureKinds, completed: outcome.completed,
        ...(outcome.completionTimeSec !== undefined ? { completionTimeSec: outcome.completionTimeSec } : {}),
        ...(outcome.firstFailure ? { firstFailure: outcome.firstFailure } : {}), engineVersion: outcome.engineVersion,
        assetsSha256: outcome.assetsSha256, controllerSha256: outcome.controllerSha256,
        ...(outcome.traceArtifactId ? { traceArtifactId: outcome.traceArtifactId } : {}),
        ...(outcome.replayArtifactId ? { replayArtifactId: outcome.replayArtifactId } : {}), spacetimeCommitted: false,
      });
      if (outcome.status === "invalid" || outcome.status === "engine_error") {
        const detail = outcome.logTail.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 300) ?? `baseline_${outcome.status}`;
        await ctx.runMutation(internal.investigations.setCapture, { investigationId: args.investigationId, captureStatus: "failed", error: detail });
        return { recorded: false, experimentId, status: outcome.status, error: detail };
      }
      if (!shouldStartAgents({ completed: outcome.completed, failureKinds: outcome.failureKinds })) {
        await ctx.runMutation(internal.investigations.setCapture, {
          investigationId: args.investigationId, captureStatus: "recorded", promote: false,
        });
        return { recorded: true, started: false, experimentId, status: outcome.status };
      }
      const capture = await ctx.runMutation(internal.investigations.setCapture, { investigationId: args.investigationId, captureStatus: "recorded" });
      if (capture.autoStart) await ctx.runMutation(internal.investigations.startInternal, { investigationId: args.investigationId });
      return { recorded: true, experimentId, status: outcome.status };
    } catch (error) {
      const code = error instanceof ConvexError ? String(error.data) : "capture_failed";
      await ctx.runMutation(internal.investigations.setCapture, { investigationId: args.investigationId, captureStatus: "failed", error: code });
      return { recorded: false, error: code };
    }
  },
});
