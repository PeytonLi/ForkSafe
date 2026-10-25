import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireInvestigationRead, requireOperateIdentity } from "./lib/webAccess.js";
import { assertUUID } from "./lib/validators.js";

const MAX_HYPOTHESIS = 280;

/** Web: `environmentHypotheses:listForInvestigation`. One pinned hypothesis per environment. */
export const listForInvestigation = query({
  args: { investigationId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireInvestigationRead(ctx, args.investigationId, args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const rows = await ctx.db.query("environmentHypotheses")
      .withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId))
      .collect();
    return rows
      .sort((a, b) => (a.environmentId < b.environmentId ? -1 : a.environmentId > b.environmentId ? 1 : 0))
      .map((row) => ({ environmentId: row.environmentId, hypothesis: row.hypothesis, updatedAtMs: row.updatedAtMs }));
  },
});

/** Web: `environmentHypotheses:set`. Empty text removes the row. This does not change scores. */
export const set = mutation({
  args: {
    investigationId: v.string(),
    environmentId: v.string(),
    hypothesis: v.string(),
    serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updatedBy = await requireOperateIdentity(ctx, args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    assertUUID(args.environmentId, "environmentId");
    const hypothesis = args.hypothesis.trim();
    if (hypothesis.length > MAX_HYPOTHESIS) throw new ConvexError("hypothesis_too_long");
    const environment = await ctx.db.query("environments").withIndex("by_appId", (q) => q.eq("appId", args.environmentId)).unique();
    if (!environment || environment.investigationId !== args.investigationId) throw new ConvexError("environment_not_found");
    const existing = await ctx.db.query("environmentHypotheses")
      .withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId))
      .unique();
    if (!hypothesis) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    const updatedAtMs = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { investigationId: args.investigationId, hypothesis, updatedAtMs, updatedBy });
    } else {
      await ctx.db.insert("environmentHypotheses", {
        investigationId: args.investigationId,
        environmentId: args.environmentId,
        hypothesis,
        updatedAtMs,
        updatedBy,
      });
    }
    return { environmentId: args.environmentId, hypothesis, updatedAtMs };
  },
});
