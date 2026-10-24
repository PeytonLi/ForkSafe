import { v } from "convex/values";
import { WorkflowManager } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";

export const workflow = new WorkflowManager(components.workflow);

/** Provisions runner and execution sandboxes, then activates environments. */
export const investigationWorkflow = workflow.define({
  args: {
    investigationId: v.string(), provider: v.union(v.literal("daytona"), v.literal("local")), runnerSnapshot: v.string(), executionSnapshot: v.string(), siteUrl: v.string(),
    // External mode leaves runner startup to an operator-managed process.
    launchMode: v.optional(v.union(v.literal("sandbox"), v.literal("external"))),
  },
  returns: v.null(),
}).handler(async (step, args) => {
  const environments = await step.runQuery(internal.workflows.getEnvironments, { investigationId: args.investigationId });
  // Reuse the execution sandbox the baseline capture already provisioned: the Daytona org has a
  // total-memory cap (10 GiB), so every extra sandbox costs runner capacity.
  const existingExecution = await step.runQuery(internal.sandboxes.readyOperationFor, { investigationId: args.investigationId, purpose: "execution" });
  if (!existingExecution) {
    await step.runMutation(internal.sandboxes.requestSandbox, {
      purpose: "execution", investigationId: args.investigationId, snapshot: args.executionSnapshot,
      resources: { cpu: 2, memoryGiB: 2, diskGiB: 10 }, provider: args.provider,
    });
  }
  if (args.launchMode === "external") {
    for (const environment of environments as any[]) {
      await step.runMutation(internal.runnerControl.issueCredential, {
        investigationId: args.investigationId, environmentId: environment.appId,
      });
      await step.runMutation(internal.workflows.activateEnvironment, { environmentId: environment.appId });
    }
    return null;
  }
  const runnerOps: { environmentId: string; sandboxOpId: string }[] = [];
  for (const environment of environments as any[]) {
    const requested = await step.runMutation(internal.sandboxes.requestSandbox, {
      purpose: "runner", investigationId: args.investigationId, environmentId: environment.appId, snapshot: args.runnerSnapshot,
      resources: { cpu: 2, memoryGiB: 2, diskGiB: 10 }, provider: args.provider,
    });
    runnerOps.push({ environmentId: environment.appId, sandboxOpId: requested.sandboxOpId });
  }
  for (const op of runnerOps) {
    let ready: { ready: boolean; queued?: boolean; detail?: string } = { ready: false };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const investigation = await step.runQuery(internal.investigations.getByAppId, { investigationId: args.investigationId });
      if (!investigation || investigation.cancelStatus !== "none"
        || ["completed", "cancelled", "failed"].includes(investigation.state)) return null;
      ready = await step.runAction(internal.workflows.awaitSandbox, { sandboxOpId: op.sandboxOpId }, { retry: true });
      if (!ready.queued) break;
    }
    if (!ready.ready) {
      await step.runMutation(internal.workflows.markEnvironmentError, {
        environmentId: op.environmentId,
        error: ready.queued ? "sandbox_queue_timeout" : ready.detail ?? "runner_sandbox_failed",
      });
      continue;
    }
    const credential = await step.runMutation(internal.runnerControl.issueCredential, {
      investigationId: args.investigationId, environmentId: op.environmentId, sandboxOpId: op.sandboxOpId,
    });
    try {
      await step.runAction(internal.execution.launchRunner, {
        sandboxOpId: op.sandboxOpId, environmentId: op.environmentId, investigationId: args.investigationId,
        credentialId: credential.credentialId, secret: credential.secret, convexSiteUrl: args.siteUrl,
      });
      await step.runMutation(internal.workflows.activateEnvironment, { environmentId: op.environmentId, sandboxOpId: op.sandboxOpId });
    } catch {
      await step.runMutation(internal.workflows.markEnvironmentError, { environmentId: op.environmentId, error: "runner_launch_failed" });
    }
  }
  return null;
});

export const launch = internalAction({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ workflowId: string }> => {
    const provider = process.env.DAYTONA_MODE === "local" ? "local" : "daytona";
    const siteUrl = process.env.CONVEX_SITE_URL ?? (process.env.CONVEX_CLOUD_URL ?? "").replace(".convex.cloud", ".convex.site");
    const workflowId: string = String(await workflow.start(
      ctx,
      internal.workflows.investigationWorkflow,
      {
        investigationId: args.investigationId, provider,
        runnerSnapshot: process.env.DAYTONA_RUNNER_SNAPSHOT ?? "forksafe-runner-v1",
        executionSnapshot: process.env.DAYTONA_EXECUTION_SNAPSHOT ?? "forksafe-exec-v1",
        siteUrl,
        launchMode: process.env.RUNNER_LAUNCH_MODE === "external" ? "external" as const : "sandbox" as const,
      },
      {
        startAsync: true,
        onComplete: internal.workflows.onWorkflowComplete,
        context: { investigationId: args.investigationId },
      },
    ));
    await ctx.runMutation(internal.investigations.attachWorkflowId, { investigationId: args.investigationId, workflowId });
    return { workflowId };
  },
});

export const getEnvironments = internalQuery({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("environments")
    .withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId))
    .collect(),
});

/** Polls a sandbox operation until it is ready (bounded, retried by the workflow). */
export const awaitSandbox = internalAction({
  args: { sandboxOpId: v.string() },
  handler: async (ctx, args): Promise<{ ready: boolean; queued?: boolean; detail?: string }> => {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const op = await ctx.runQuery(internal.sandboxes.getSandboxOp, { sandboxOpId: args.sandboxOpId });
      if (!op) return { ready: false, detail: "sandbox_operation_not_found" };
      if (op.status === "ready" && op.sandbox) return { ready: true };
      if (["error", "terminated", "terminating"].includes(op.status)) return { ready: false, detail: op.lastError ?? op.status };
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    const op = await ctx.runQuery(internal.sandboxes.getSandboxOp, { sandboxOpId: args.sandboxOpId });
    if (op?.status === "queued") return { ready: false, queued: true };
    return { ready: false, detail: "sandbox_timeout" };
  },
});

export const activateEnvironment = internalMutation({
  args: { environmentId: v.string(), sandboxOpId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const environment = await ctx.db.query("environments").withIndex("by_appId", (q) => q.eq("appId", args.environmentId)).unique();
    const op = args.sandboxOpId
      ? await ctx.db.query("sandboxOps").withIndex("by_appId", (q) => q.eq("appId", args.sandboxOpId!)).unique()
      : null;
    if (!environment) return { updated: false };
    await ctx.db.patch(environment._id, {
      state: "active",
      ...(args.sandboxOpId ? { runnerSandboxOpId: args.sandboxOpId } : {}),
      startedAtMs: environment.startedAtMs ?? Date.now(),
      ...(op?.sandbox ? { daytonaSandbox: op.sandbox } : {}),
    });
    return { updated: true };
  },
});

export const onWorkflowComplete = internalMutation({
  args: {
    workflowId: v.string(),
    context: v.object({ investigationId: v.string() }),
    result: v.any(),
  },
  handler: async (ctx, args) => {
    if (args.result?.kind === "success") return { handled: false };
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.context.investigationId))
      .unique();
    if (!investigation) return { handled: false };
    const now = Date.now();
    const reason = args.result?.kind === "canceled" ? "workflow_cancelled" : "workflow_failed";
    const environments = await ctx.db.query("environments")
      .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
      .collect();
    for (const environment of environments) {
      if (!["closed", "error"].includes(environment.state)) {
        await ctx.db.patch(environment._id, { state: "error", lastError: reason, closedAtMs: now });
      }
    }
    if (!["completed", "cancelled", "failed"].includes(investigation.state)) {
      await ctx.db.patch(investigation._id, {
        state: "failed",
        lastError: reason,
        updatedAtMs: now,
        finishedAtMs: now,
        version: investigation.version + 1,
      });
    }
    await ctx.scheduler.runAfter(0, internal.sandboxes.terminateInvestigationOps, {
      investigationId: investigation.appId,
      reason,
    });
    await ctx.scheduler.runAfter(0, internal.runnerControl.revokeCredentials, {
      investigationId: investigation.appId,
      reason,
    });
    return { handled: true };
  },
});

export const markEnvironmentError = internalMutation({
  args: { environmentId: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    const environment = await ctx.db.query("environments").withIndex("by_appId", (q) => q.eq("appId", args.environmentId)).unique();
    if (!environment) return { updated: false };
    await ctx.db.patch(environment._id, { state: "error", lastError: args.error.slice(0, 200), closedAtMs: Date.now() });
    const jobs = await ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", environment.investigationId)).collect();
    const now = Date.now();
    for (const job of jobs) {
      if (job.environmentId === args.environmentId && job.state === "reserved") {
        await ctx.db.patch(job._id, { state: "failed", lastError: args.error.slice(0, 200), updatedAtMs: now });
      }
    }
    await ctx.scheduler.runAfter(0, internal.investigations.afterEnvironmentJobSettled, { investigationId: environment.investigationId });
    return { updated: true };
  },
});
