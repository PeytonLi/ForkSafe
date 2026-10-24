import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { GRANT_TTL_MS } from "./lib/constants.js";
import { appId, assertUUID } from "./lib/validators.js";

export const RUNNER_GRANT_OPERATIONS = [
  "heartbeat", "acquire_revision_lease", "renew_revision_lease", "release_revision_lease",
  "commit_revision", "record_artifact", "record_experiment", "record_finding", "submit_candidate",
] as const;
export const EVALUATOR_GRANT_OPERATIONS = [
  "heartbeat", "record_artifact", "record_experiment", "record_evaluation",
] as const;

/** Creates the Convex-side grant row for an attempt (idempotent per attempt). */
export const create = internalMutation({
  args: {
    jobId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    investigationId: v.string(),
    environmentId: v.optional(v.string()),
    purpose: v.union(v.literal("runner"), v.literal("evaluator")),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertUUID(args.jobId, "jobId");
    assertUUID(args.attemptId, "attemptId");
    const existing = await ctx.db.query("grants").withIndex("by_attempt", (q) => q.eq("attemptId", args.attemptId)).unique();
    if (existing) return { grantId: existing.appId, duplicate: true, expiresAtMs: existing.expiresAtMs };
    const attempt = await ctx.db.query("attempts").withIndex("by_appId", (q) => q.eq("appId", args.attemptId)).unique();
    const job = await ctx.db.query("jobs").withIndex("by_appId", (q) => q.eq("appId", args.jobId)).unique();
    if (!attempt || !job || attempt.jobId !== job.appId) throw new ConvexError("attempt_not_found");
    if (job.activeAttemptId !== attempt.appId || job.epoch !== args.epoch || attempt.epoch !== args.epoch) {
      throw new ConvexError("stale_epoch");
    }
    const now = Date.now();
    const grantId = appId();
    const expiresAtMs = now + (args.ttlMs ?? GRANT_TTL_MS);
    await ctx.db.insert("grants", {
      appId: grantId,
      jobId: args.jobId,
      attemptId: args.attemptId,
      epoch: args.epoch,
      investigationId: args.investigationId,
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      scope: {
        operations: [...(args.purpose === "runner" ? RUNNER_GRANT_OPERATIONS : EVALUATOR_GRANT_OPERATIONS)],
        artifactPrefixes: [`inv/${args.investigationId}/`],
        maxBytes: 64 * 1024 * 1024,
      },
      expiresAtMs,
      bridgeMode: "blocked",
      spacetimeInstalled: false,
      spacetimeRevoked: false,
      createdAtMs: now,
    });
    await ctx.db.patch(attempt._id, { grantId, grantExpiresAtMs: expiresAtMs });
    return { grantId, duplicate: false, expiresAtMs };
  },
});

export const markInstalled = internalMutation({
  args: {
    grantId: v.string(),
    committed: v.boolean(),
    mode: v.union(v.literal("live"), v.literal("local"), v.literal("fixture"), v.literal("blocked"), v.literal("not_implemented")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await ctx.db.query("grants").withIndex("by_appId", (q) => q.eq("appId", args.grantId)).unique();
    if (!grant) throw new ConvexError("grant_not_found");
    await ctx.db.patch(grant._id, {
      bridgeMode: args.mode,
      spacetimeInstalled: args.committed,
      ...(args.committed ? { installedAtMs: Date.now(), lastError: undefined } : { lastError: args.error ?? "install_failed" }),
    });
    return { updated: true };
  },
});

export const markRevoked = internalMutation({
  args: { grantId: v.string(), spacetimeRevoked: v.boolean(), reason: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const grant = await ctx.db.query("grants").withIndex("by_appId", (q) => q.eq("appId", args.grantId)).unique();
    if (!grant) return { updated: false };
    await ctx.db.patch(grant._id, {
      revokedAtMs: grant.revokedAtMs ?? Date.now(),
      revokeReason: grant.revokeReason ?? args.reason,
      spacetimeRevoked: args.spacetimeRevoked,
      ...(args.error ? { lastError: args.error } : {}),
    });
    const attempt = await ctx.db.query("attempts").withIndex("by_appId", (q) => q.eq("appId", grant.attemptId)).unique();
    if (attempt && args.spacetimeRevoked && !attempt.grantRevokedAtMs) {
      await ctx.db.patch(attempt._id, { grantRevokedAtMs: Date.now() });
    }
    const job = await ctx.db.query("jobs").withIndex("by_appId", (q) => q.eq("appId", grant.jobId)).unique();
    if (job && args.spacetimeRevoked && job.pendingRevocation?.attemptId === grant.attemptId) {
      await ctx.db.patch(job._id, { pendingRevocation: undefined, updatedAtMs: Date.now() });
    }
    return { updated: true };
  },
});

export const getByAttempt = internalQuery({
  args: { attemptId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("grants").withIndex("by_attempt", (q) => q.eq("attemptId", args.attemptId)).unique(),
});

/** Grants that still need a SpacetimeDB revoke (lease expired, cancelled, completed). */
export const pendingRevocations = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("grants")
      .withIndex("by_pending_revoke", (q) => q.eq("spacetimeRevoked", false))
      .take(200);
    return rows.filter((row) => row.revokedAtMs !== undefined && row.spacetimeInstalled);
  },
});
