import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { action, internalMutation, internalQuery } from "./_generated/server.js";
import { requireWriteIdentity } from "./lib/webAccess.js";
import { appId, assertUUID } from "./lib/validators.js";

/** Web: `reviews:record` — a human decision bound to the exact controller
 *  sha of an evaluated candidate. SpacetimeDB is written first (bridge), then
 *  the Convex projection; both are keyed by the review id. */

const decision = v.union(v.literal("approved"), v.literal("rejected"), v.literal("needs_changes"));

export const validate = internalQuery({
  args: { investigationId: v.string(), candidateId: v.string(), evaluationId: v.string(), controllerSha256: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("reviews").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing) return { existing };
    const candidate = await ctx.db.query("candidates").withIndex("by_appId", (q) => q.eq("appId", args.candidateId)).unique();
    if (!candidate || candidate.investigationId !== args.investigationId) throw new ConvexError("candidate not found in investigation");
    if (candidate.controllerSha256 !== args.controllerSha256) throw new ConvexError("controllerSha256 does not match the candidate");
    const evaluation = await ctx.db.query("evaluations").withIndex("by_appId", (q) => q.eq("appId", args.evaluationId)).unique();
    if (!evaluation || evaluation.candidateId !== candidate.appId) throw new ConvexError("evaluation not found for candidate");
    if (!["passed", "failed", "invalid"].includes(evaluation.status)) throw new ConvexError("evaluation is not terminal");
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique();
    if (!investigation || !["awaiting_review", "completed"].includes(investigation.state)) throw new ConvexError("investigation is not awaiting review");
    return { existing: null, jiraIssueKey: investigation.jiraIssueKey };
  },
});

export const insert = internalMutation({
  args: {
    reviewId: v.string(), investigationId: v.string(), candidateId: v.string(), evaluationId: v.string(), controllerSha256: v.string(),
    decision, reviewerIdentity: v.string(), notes: v.optional(v.string()), jiraIssueKey: v.optional(v.string()), idempotencyKey: v.string(), spacetimeCommitted: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("reviews").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing) return existing;
    const { reviewId, ...rest } = args;
    const row = { appId: reviewId, ...rest, createdAtMs: Date.now() };
    await ctx.db.insert("reviews", row);
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique();
    if (investigation && investigation.state === "awaiting_review" && args.decision === "approved") {
      await ctx.db.patch(investigation._id, { state: "completed", version: investigation.version + 1, updatedAtMs: Date.now(), finishedAtMs: Date.now() });
    }
    return row;
  },
});

function toHumanReview(row: any) {
  return {
    id: row.appId, investigationId: row.investigationId, candidateId: row.candidateId, evaluationId: row.evaluationId,
    controllerSha256: row.controllerSha256, decision: row.decision, reviewerIdentity: row.reviewerIdentity,
    ...(row.notes ? { notes: row.notes } : {}), ...(row.jiraIssueKey ? { jiraIssueKey: row.jiraIssueKey } : {}), createdAtMs: row.createdAtMs,
  };
}

export const record = action({
  args: {
    investigationId: v.string(), candidateId: v.string(), evaluationId: v.string(), controllerSha256: v.string(),
    decision, notes: v.optional(v.string()), idempotencyKey: v.optional(v.string()), serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const reviewerIdentity = await requireWriteIdentity(ctx, args.serviceToken);
    for (const [name, value] of [["investigationId", args.investigationId], ["candidateId", args.candidateId], ["evaluationId", args.evaluationId]] as const) assertUUID(value, name);
    if (!/^[0-9a-f]{64}$/.test(args.controllerSha256)) throw new ConvexError("controllerSha256 must be lowercase sha256");
    if (args.notes && args.notes.length > 4000) throw new ConvexError("notes too long");
    const idempotencyKey = args.idempotencyKey ?? `${args.evaluationId}:${args.controllerSha256}:${args.decision}:${reviewerIdentity}`;
    const check = await ctx.runQuery(internal.reviews.validate, { investigationId: args.investigationId, candidateId: args.candidateId, evaluationId: args.evaluationId, controllerSha256: args.controllerSha256, idempotencyKey });
    if (check.existing) return toHumanReview(check.existing);
    const reviewId = appId();
    let committed = false;
    try {
      const result = await ctx.runAction(internal.bridge.recordReview, {
        id: reviewId, investigationId: args.investigationId, candidateId: args.candidateId, evaluationId: args.evaluationId,
        controllerSha256: args.controllerSha256, decision: args.decision, reviewerIdentity, ...(args.notes ? { notes: args.notes } : {}),
        ...(check.jiraIssueKey ? { jiraIssueKey: check.jiraIssueKey } : {}),
      });
      committed = result.committed;
    } catch {
      committed = false;
    }
    const row = await ctx.runMutation(internal.reviews.insert, {
      reviewId, investigationId: args.investigationId, candidateId: args.candidateId, evaluationId: args.evaluationId, controllerSha256: args.controllerSha256,
      decision: args.decision, reviewerIdentity, ...(args.notes ? { notes: args.notes } : {}), ...(check.jiraIssueKey ? { jiraIssueKey: check.jiraIssueKey } : {}),
      idempotencyKey, spacetimeCommitted: committed,
    });
    return toHumanReview(row);
  },
});
