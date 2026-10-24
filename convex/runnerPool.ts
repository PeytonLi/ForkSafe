import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { RUNNER_POOL_LEASE_MS } from "./lib/constants.js";
import { issueRunnerCredential } from "./lib/runnerCredentials.js";

const workerIdPattern = /^[A-Za-z0-9._:-]{3,120}$/;

export const claim = internalMutation({
  args: { poolWorkerId: v.string() },
  handler: async (ctx, args) => {
    if (process.env.RUNNER_LAUNCH_MODE !== "external" || !workerIdPattern.test(args.poolWorkerId)) return null;
    const now = Date.now();
    const environments = await ctx.db.query("environments")
      .withIndex("by_state", (q) => q.eq("state", "active"))
      .collect();
    const waiting: Array<{ environment: any; investigation: any; createdAtMs: number }> = [];
    for (const environment of environments) {
      if (environment.leasedUntilMs !== undefined && environment.leasedUntilMs > now) continue;
      const investigation = await ctx.db.query("investigations")
        .withIndex("by_appId", (q) => q.eq("appId", environment.investigationId))
        .unique();
      if (!investigation || investigation.state !== "searching" || investigation.cancelStatus !== "none") continue;
      const [jobs, operations, credentials] = await Promise.all([
        ctx.db.query("jobs").withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId)).collect(),
        ctx.db.query("sandboxOps").withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId)).collect(),
        ctx.db.query("runnerCredentials").withIndex("by_environment", (q) => q.eq("environmentId", environment.appId)).collect(),
      ]);
      if (!jobs.some((job) => job.environmentId === environment.appId && job.kind === "factory_session" && job.state === "reserved")) continue;
      if (!operations.some((op) => op.purpose === "execution" && op.status === "ready" && op.sandbox)) continue;
      const credential = credentials
        .filter((row) => row.revokedAtMs === undefined && row.expiresAtMs > now)
        .sort((left, right) => right.createdAtMs - left.createdAtMs)[0];
      if (credential?.workerId && credential.lastSeenAtMs !== undefined
        && credential.lastSeenAtMs > now - RUNNER_POOL_LEASE_MS) continue;
      waiting.push({
        environment,
        investigation,
        createdAtMs: environment.startedAtMs ?? investigation.startedAtMs ?? investigation.createdAtMs,
      });
    }
    waiting.sort((left, right) =>
      left.createdAtMs - right.createdAtMs
      || left.environment.index - right.environment.index
      || left.environment.appId.localeCompare(right.environment.appId));
    const selected = waiting[0];
    if (!selected) return null;
    const credential = await issueRunnerCredential(ctx, {
      investigationId: selected.investigation.appId,
      environmentId: selected.environment.appId,
    });
    await ctx.db.patch(selected.environment._id, {
      poolWorkerId: args.poolWorkerId,
      leasedUntilMs: now + RUNNER_POOL_LEASE_MS,
    });
    return {
      ...credential,
      environmentId: selected.environment.appId,
      investigationId: selected.investigation.appId,
    };
  },
});

export const release = internalMutation({
  args: { credentialId: v.string(), poolWorkerId: v.string() },
  handler: async (ctx, args) => {
    const credential = await ctx.db.query("runnerCredentials")
      .withIndex("by_appId", (q) => q.eq("appId", args.credentialId))
      .unique();
    if (!credential) return { released: false };
    const environment = await ctx.db.query("environments")
      .withIndex("by_appId", (q) => q.eq("appId", credential.environmentId))
      .unique();
    if (!environment || environment.runnerCredentialId !== credential.appId || environment.poolWorkerId !== args.poolWorkerId) {
      return { released: false };
    }
    const now = Date.now();
    await ctx.db.patch(environment._id, { poolWorkerId: undefined, leasedUntilMs: undefined });
    if (credential.revokedAtMs === undefined) {
      await ctx.db.patch(credential._id, { revokedAtMs: now, revokeReason: "pool_release" });
    }
    return { released: true };
  },
});
