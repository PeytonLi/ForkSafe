import { v } from "convex/values";
import { WorkflowManager } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { appId } from "./lib/validators.js";

export const workflow = new WorkflowManager(components.workflow);

export const investigationWorkflow = workflow.define({
  args: {
    investigationId: v.string(),
    provider: v.union(v.literal("daytona"), v.literal("local")),
    snapshot: v.string(),
  },
  returns: v.null(),
}).handler(async (step, args) => {
  const environments = await step.runQuery(internal.workflows.getEnvironments, {
    investigationId: args.investigationId,
  });
  const sandboxOps = await Promise.all(environments.map((environment: any) =>
    step.runMutation(internal.sandboxes.requestSandbox, {
      purpose: "execution",
      investigationId: args.investigationId,
      environmentId: environment.appId,
      snapshot: args.snapshot,
      resources: { cpu: 2, memoryGiB: 4, diskGiB: 10 },
      provider: args.provider,
    }),
  ));
  await step.runMutation(internal.workflows.linkProvisionJobs, {
    investigationId: args.investigationId,
    sandboxOps: sandboxOps.map((item: any) => item.sandboxOpId),
  });
  return null;
});

export const launch = internalAction({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ workflowId: string }> => {
    const provider = process.env.DAYTONA_MODE === "local" ? "local" : "daytona";
    const snapshot = process.env.DAYTONA_EXECUTION_SNAPSHOT ?? "forksafe-exec-v1";
    const workflowId: string = String(await workflow.start(
      ctx,
      internal.workflows.investigationWorkflow,
      { investigationId: args.investigationId, provider, snapshot },
      { startAsync: true },
    ));
    await ctx.runMutation(internal.investigations.attachWorkflowId, {
      investigationId: args.investigationId,
      workflowId,
    });
    return { workflowId };
  },
});

export const getEnvironments = internalQuery({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("environments")
    .withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId))
    .collect(),
});

export const linkProvisionJobs = internalMutation({
  args: { investigationId: v.string(), sandboxOps: v.array(v.string()) },
  handler: async (ctx, args) => {
    const jobs = await ctx.db.query("jobs")
      .withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId))
      .collect();
    for (let index = 0; index < args.sandboxOps.length; index += 1) {
      const sandboxOpId = args.sandboxOps[index]!;
      const env = await ctx.db.query("sandboxOps")
        .withIndex("by_appId", (q) => q.eq("appId", sandboxOpId))
        .unique();
      if (!env?.environmentId) continue;
      const job = jobs.find((item) => item.environmentId === env.environmentId);
      if (!job) continue;
      if (env.jobId) await ctx.db.patch(job._id, { dependsOn: [env.jobId], updatedAtMs: Date.now() });
    }
  },
});
