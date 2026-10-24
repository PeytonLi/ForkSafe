"use node";

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, action } from "./_generated/server.js";
import { Daytona } from "@daytonaio/sdk";
import type { VendorRef } from "@forksafe/contracts";
import {
  CloudDaytonaProvider,
  loadDaytonaConfig,
  type SandboxPurpose,
} from "@forksafe/daytona";
import { requireServiceToken } from "./lib/auth.js";
import { LOG_TAIL_MAX_BYTES } from "./lib/constants.js";
import { assertUUID } from "./lib/validators.js";

function createCloudProvider(): CloudDaytonaProvider {
  const config = loadDaytonaConfig();
  if (config.mode !== "cloud" || !config.apiKey) throw new ConvexError("daytona_cloud_provider_blocked");
  return new CloudDaytonaProvider(new Daytona({ apiKey: config.apiKey, apiUrl: config.apiUrl }), config);
}

function makeLabels(spec: {
  operationId: string;
  purpose: "runner" | "execution" | "evaluator" | "bridge";
  investigationId: string;
  environmentId?: string;
  attemptId?: string;
}) {
  return {
    "forksafe.project": "forksafe" as const,
    "forksafe.operation": spec.operationId,
    "forksafe.purpose": spec.purpose,
    "forksafe.investigation": spec.investigationId,
    ...(spec.environmentId ? { "forksafe.environment": spec.environmentId } : {}),
    ...(spec.attemptId ? { "forksafe.attempt": spec.attemptId } : {}),
  };
}

export const provision = internalAction({
  args: { sandboxOpId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const op: any = await ctx.runQuery(internal.sandboxes.getSandboxOp, args);
    if (!op) throw new ConvexError("sandbox_operation_not_found");
    if (op.status === "ready" && op.sandbox) return { sandboxOpId: op.appId, duplicate: true };
    await ctx.runMutation(internal.sandboxes.updateSandboxOp, { sandboxOpId: op.appId, status: "creating" });
    try {
      const provider = createCloudProvider();
      const found = await provider.findByOperation(op.appId);
      const handle = found ?? await provider.create({
        operationId: op.appId,
        purpose: op.purpose,
        labels: makeLabels({
          operationId: op.appId,
          purpose: op.purpose,
          investigationId: op.investigationId,
          environmentId: op.environmentId,
          attemptId: op.attemptId,
        }),
        snapshot: op.snapshot,
        resources: op.resources,
        reservedSandboxCount: op.reservedSandboxCount ?? 0,
        autoStopMinutes: loadDaytonaConfig().defaults[op.purpose as SandboxPurpose].autoStopMinutes,
        autoDeleteMinutes: loadDaytonaConfig().defaults[op.purpose as SandboxPurpose].autoDeleteMinutes,
        createTimeoutSec: 120,
      });
      await ctx.runMutation(internal.sandboxes.updateSandboxOp, {
        sandboxOpId: op.appId,
        status: "ready",
        sandbox: handle.ref,
      });
      if (op.environmentId && op.purpose !== "runner") {
        await ctx.runMutation(internal.sandboxes.markEnvironmentReady, {
          environmentId: op.environmentId,
          sandbox: handle.ref,
        });
      }
      return { sandboxOpId: op.appId, ref: handle.ref };
    } catch {
      await ctx.runMutation(internal.sandboxes.updateSandboxOp, {
        sandboxOpId: op.appId,
        status: "ambiguous_create",
        lastError: "sandbox_create_ambiguous",
      });
      return { sandboxOpId: op.appId, ambiguous: true };
    }
  },
});

export const terminate = internalAction({
  args: { sandboxOpId: v.string() },
  handler: async (ctx, args) => {
    const op = await ctx.runQuery(internal.sandboxes.getSandboxOp, args);
    if (!op) throw new ConvexError("sandbox_operation_not_found");
    if (op.status === "terminated") return { alreadyGone: true };
    await ctx.runMutation(internal.sandboxes.updateSandboxOp, { sandboxOpId: op.appId, status: "terminating" });
    if (!op.sandbox) {
      // Nothing addressable was ever created (create failed or was rejected), so there is nothing
      // to destroy; release the reservation so cancellation can finalize. Untracked sandboxes are
      // caught by the label-based orphan sweep, not by this op.
      await ctx.runMutation(internal.sandboxes.updateSandboxOp, {
        sandboxOpId: op.appId,
        status: "terminated",
        terminatedAtMs: Date.now(),
        releaseReservation: true,
        lastError: "sandbox_reference_missing",
      });
      return { alreadyGone: true, noSandbox: true };
    }
    try {
      const provider = createCloudProvider();
      const result = await provider.destroy(op.sandbox as VendorRef);
      await ctx.runMutation(internal.sandboxes.updateSandboxOp, {
        sandboxOpId: op.appId,
        status: "terminated",
        terminatedAtMs: Date.now(),
        releaseReservation: true,
      });
      return result;
    } catch {
      await ctx.runMutation(internal.sandboxes.updateSandboxOp, {
        sandboxOpId: op.appId,
        status: "ambiguous_terminate",
        lastError: "sandbox_termination_ambiguous",
      });
      return { ambiguous: true };
    }
  },
});

export const reconcileSandbox = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const ops: any[] = await ctx.runQuery(internal.sandboxes.listOperations, {});
    if (process.env.DAYTONA_MODE === "local") return { resolved: 0, orphanedDestroyed: 0, localWorkerRequired: true };
    const provider = createCloudProvider();
    const owned = await provider.listOwned({ "forksafe.project": "forksafe" });
    const byOperation = new Map(owned.map((sandbox) => [sandbox.labels["forksafe.operation"], sandbox]));
    const known = new Set<string>(ops.map((op: any) => op.appId));
    let resolved = 0;
    for (const op of ops as any[]) {
      if (op.status === "ambiguous_create") {
        const sandbox = byOperation.get(op.appId);
        if (sandbox) {
          await ctx.runMutation(internal.sandboxes.updateSandboxOp, {
            sandboxOpId: op.appId,
            status: "ready",
            sandbox: sandbox.ref,
          });
          resolved += 1;
        }
      } else if (op.status === "ambiguous_terminate" && op.sandbox) {
        const sandbox = await provider.get(op.sandbox as VendorRef);
        if (!sandbox) {
          await ctx.runMutation(internal.sandboxes.updateSandboxOp, {
            sandboxOpId: op.appId,
            status: "terminated",
            terminatedAtMs: Date.now(),
            releaseReservation: true,
          });
          resolved += 1;
        }
      }
    }
    for (const sandbox of owned) {
      const operationId = sandbox.labels["forksafe.operation"];
      if (operationId && !known.has(operationId)) await provider.destroy(sandbox.ref);
    }
    return { resolved, orphanedDestroyed: owned.filter((item) => !known.has(item.labels["forksafe.operation"] ?? "")).length };
  },
});

export const runCommand = action({
  args: {
    jobId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    sandboxOpId: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
    serviceToken: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    requireServiceToken(args.serviceToken);
    const access = await ctx.runQuery(internal.sandboxData.authorizeCommand, {
      jobId: args.jobId,
      attemptId: args.attemptId,
      epoch: args.epoch,
      sandboxOpId: args.sandboxOpId,
      command: args.command,
      cwd: args.cwd,
    });
    if (!access.ref) throw new ConvexError("sandbox_not_ready");
    const provider = createCloudProvider();
    const handle = await provider.startCommand(access.ref as VendorRef, { command: args.command, cwd: args.cwd });
    return await ctx.runMutation(internal.sandboxData.saveCommand, {
      sandboxOpId: args.sandboxOpId,
      jobId: args.jobId,
      attemptId: args.attemptId,
      epoch: args.epoch,
      command: args.command,
      handle,
    });
  },
});

export const pollCommand = action({
  args: {
    commandId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    serviceToken: v.string(),
    maxBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireServiceToken(args.serviceToken);
    assertUUID(args.commandId, "commandId");
    const { command, sandbox } = await ctx.runQuery(internal.sandboxData.getCommand, {
      commandId: args.commandId,
      attemptId: args.attemptId,
      epoch: args.epoch,
    });
    const provider = createCloudProvider();
    const result = await provider.pollCommand(sandbox as VendorRef, command.handle!, {
      maxBytes: Math.min(args.maxBytes ?? LOG_TAIL_MAX_BYTES, LOG_TAIL_MAX_BYTES),
    });
    await ctx.runMutation(internal.sandboxData.updateCommand, {
      commandId: command.appId,
      status: !result.done ? "running" : result.exitCode === 0 ? "exited" : "failed",
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      logTail: result.logs,
    });
    return result;
  },
});
