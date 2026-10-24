import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api.js";
import { mutation, query, internalMutation } from "./_generated/server.js";
import { readLimits } from "./lib/constants.js";
import { countsTowardCapacity } from "./lib/reservations.js";
import { requireUiAccess } from "./lib/auth.js";
import { appId, assertUUID } from "./lib/validators.js";

const simCase = v.object({
  caseId: v.string(),
  suite: v.union(v.literal("original"), v.literal("public"), v.literal("withheld")),
  seed: v.number(),
  sceneOverrides: v.record(v.string(), v.number()),
  description: v.optional(v.string()),
});

export const create = mutation({
  args: {
    title: v.string(),
    requestedEnvironments: v.optional(v.number()),
    baselineCase: v.optional(simCase),
    baselineExperimentId: v.optional(v.string()),
    jiraIssueKey: v.optional(v.string()),
    idempotencyKey: v.string(),
    serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    const existing = await ctx.db.query("investigations")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing) return { investigationId: existing.appId, duplicate: true };
    const limits = readLimits();
    const requestedEnvironments = args.requestedEnvironments ?? limits.defaultEnvironments;
    if (!args.title.trim()) throw new ConvexError("title_required");
    if (!Number.isInteger(requestedEnvironments) || requestedEnvironments < 1 || requestedEnvironments > limits.maxEnvironments) {
      throw new ConvexError("requestedEnvironments_out_of_range");
    }
    if (args.idempotencyKey.length < 8) throw new ConvexError("idempotencyKey_too_short");
    const now = Date.now();
    const investigationId = appId();
    const baselineCase = args.baselineCase ?? {
      caseId: appId(),
      suite: "original" as const,
      seed: 1,
      sceneOverrides: {},
    };
    if (args.baselineExperimentId) assertUUID(args.baselineExperimentId, "baselineExperimentId");
    await ctx.db.insert("investigations", {
      appId: investigationId,
      title: args.title.trim(),
      state: "capturing",
      cancelStatus: "none",
      cancelEpoch: 0,
      version: 1,
      requestedEnvironments,
      baselineCase,
      baselineExperimentId: args.baselineExperimentId ?? appId(),
      ...(args.jiraIssueKey ? { jiraIssueKey: args.jiraIssueKey } : {}),
      budget: {
        wallTimeMs: 600_000,
        maxExperimentsPerEnv: 20,
        maxCandidatesPerEnv: 2,
        maxFinalCandidates: 3,
      },
      idempotencyKey: args.idempotencyKey,
      createdAtMs: now,
      updatedAtMs: now,
    });
    return { investigationId, duplicate: false };
  },
});

export const start = mutation({
  args: { investigationId: v.string(), expectedVersion: v.number(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation) throw new ConvexError("investigation_not_found");
    if (investigation.state === "admitted" || investigation.state === "searching") {
      return { investigationId: investigation.appId, duplicate: true };
    }
    if (investigation.version !== args.expectedVersion) throw new ConvexError("version_conflict");
    if (investigation.state !== "capturing") throw new ConvexError("investigation_not_startable");
    const flag = await ctx.db.query("systemFlags").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (flag?.admissionPaused) throw new ConvexError("admission_paused");
    const now = Date.now();
    const jobIds: string[] = [];
    for (let index = 0; index < investigation.requestedEnvironments; index += 1) {
      const environmentId = appId();
      const jobId = appId();
      jobIds.push(jobId);
      const operationId = appId();
      await ctx.db.insert("environments", {
        appId: environmentId,
        investigationId: investigation.appId,
        index,
        state: "provisioning",
        budgets: {
          maxExperiments: investigation.budget.maxExperimentsPerEnv,
          maxCandidates: investigation.budget.maxCandidatesPerEnv,
          maxFactorySessions: 2,
          wallTimeMs: investigation.budget.wallTimeMs,
        },
        experimentsUsed: 0,
        candidatesUsed: 0,
      });
      await ctx.db.insert("jobs", {
        appId: jobId,
        kind: "factory_session",
        state: "reserved",
        investigationId: investigation.appId,
        environmentId,
        epoch: 0,
        idempotencyKey: `${investigation.appId}:factory:${index}`,
        payload: { environmentIndex: index },
        attemptsUsed: 0,
        maxAttempts: 2,
        operationId,
        admittedCancelEpoch: investigation.cancelEpoch,
        dependsOn: [],
        createdAtMs: now,
        updatedAtMs: now,
      });
      await ctx.db.insert("reservations", {
        appId: appId(),
        kind: "environment_job",
        status: "active",
        investigationId: investigation.appId,
        holder: { jobId },
        operationId,
        createdAtMs: now,
      });
      await ctx.db.insert("handoffs", {
        operationId,
        jobId,
        stage: "admission_reserved",
        detail: { environmentId },
        atMs: now,
        epoch: 0,
        stale: false,
      });
    }
    await ctx.db.patch(investigation._id, {
      state: "searching",
      version: investigation.version + 1,
      startedAtMs: now,
      updatedAtMs: now,
    });
    await ctx.scheduler.runAfter(0, internal.workflows.launch, { investigationId: investigation.appId });
    return { investigationId: investigation.appId, duplicate: false, jobIds };
  },
});

export const enterEvaluation = internalMutation({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ scheduled: boolean; duplicate?: boolean }> => {
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation || investigation.state !== "searching") return { scheduled: false };
    const jobs = await ctx.db.query("jobs")
      .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
      .collect();
    const factoryJobs = jobs.filter((job) => job.kind === "factory_session");
    if (!factoryJobs.length || factoryJobs.some((job) => job.state !== "succeeded")) return { scheduled: false };
    if (jobs.some((job) => job.kind === "evaluate_candidate")) return { scheduled: false, duplicate: true };
    const environmentId = appId();
    const jobId = appId();
    const operationId = appId();
    const now = Date.now();
    await ctx.db.insert("environments", {
      appId: environmentId,
      investigationId: investigation.appId,
      index: factoryJobs.length,
      state: "provisioning",
      budgets: {
        maxExperiments: investigation.budget.maxExperimentsPerEnv,
        maxCandidates: investigation.budget.maxCandidatesPerEnv,
        maxFactorySessions: 1,
        wallTimeMs: investigation.budget.wallTimeMs,
      },
      experimentsUsed: 0,
      candidatesUsed: 0,
    });
    await ctx.db.insert("jobs", {
      appId: jobId,
      kind: "evaluate_candidate",
      state: "reserved",
      investigationId: investigation.appId,
      environmentId,
      epoch: 0,
      idempotencyKey: `${investigation.appId}:evaluate_candidate`,
      payload: { purpose: "evaluator" },
      attemptsUsed: 0,
      maxAttempts: 2,
      operationId,
      admittedCancelEpoch: investigation.cancelEpoch,
      dependsOn: [],
      createdAtMs: now,
      updatedAtMs: now,
    });
    await ctx.db.insert("reservations", {
      appId: appId(),
      kind: "environment_job",
      status: "active",
      investigationId: investigation.appId,
      environmentId,
      holder: { jobId },
      operationId,
      createdAtMs: now,
    });
    await ctx.db.patch(investigation._id, {
      state: "evaluating",
      version: investigation.version + 1,
      updatedAtMs: now,
    });
    const provider = process.env.DAYTONA_MODE === "local" ? "local" : "daytona";
    await ctx.scheduler.runAfter(0, internal.sandboxes.requestSandbox, {
      purpose: "evaluator",
      investigationId: investigation.appId,
      environmentId,
      jobId,
      snapshot: process.env.DAYTONA_EXECUTION_SNAPSHOT ?? "forksafe-exec-v1",
      resources: { cpu: 2, memoryGiB: 4, diskGiB: 10 },
      provider,
    });
    return { scheduled: true };
  },
});

export const get = query({
  args: { investigationId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    return await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
  },
});

export const attachWorkflowId = internalMutation({
  args: { investigationId: v.string(), workflowId: v.string() },
  handler: async (ctx, args) => {
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation) throw new ConvexError("investigation_not_found");
    await ctx.db.patch(investigation._id, {
      workflowId: args.workflowId,
      updatedAtMs: Date.now(),
      version: investigation.version + 1,
    });
  },
});

export const cancel = mutation({
  args: { investigationId: v.string(), expectedVersion: v.number(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation) throw new ConvexError("investigation_not_found");
    if (investigation.version !== args.expectedVersion) throw new ConvexError("version_conflict");
    if (["completed", "cancelled", "failed"].includes(investigation.state)) {
      return { investigationId: investigation.appId, duplicate: true };
    }
    const now = Date.now();
    const cancelEpoch = investigation.cancelEpoch + 1;
    await ctx.db.patch(investigation._id, {
      cancelStatus: "cancel_requested",
      cancelEpoch,
      version: investigation.version + 1,
      updatedAtMs: now,
    });
    const jobs = await ctx.db.query("jobs")
      .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
      .collect();
    for (const job of jobs) {
      if (["succeeded", "failed", "cancelled"].includes(job.state)) continue;
      if (!job.activeAttemptId) {
        await ctx.db.patch(job._id, { state: "cancelled", cancelRequestedAtMs: now, updatedAtMs: now });
        const reservations = await ctx.db.query("reservations")
          .withIndex("by_operation", (q) => q.eq("operationId", job.operationId))
          .collect();
        for (const reservation of reservations) {
          if (countsTowardCapacity(reservation.status) && reservation.kind !== "sandbox") {
            await ctx.db.patch(reservation._id, { status: "released", releasedAtMs: now, releaseReason: "cancelled" });
          }
        }
      } else {
        await ctx.db.patch(job._id, { cancelRequestedAtMs: now, updatedAtMs: now });
      }
    }
    const sandboxOps = await ctx.db.query("sandboxOps")
      .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
      .collect();
    for (const op of sandboxOps) {
      if (op.status !== "terminated") await ctx.scheduler.runAfter(0, internal.sandboxActions.terminate, { sandboxOpId: op.appId });
    }
    return { investigationId: investigation.appId, duplicate: false };
  },
});
