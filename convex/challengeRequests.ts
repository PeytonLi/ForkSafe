import { ConvexError, v } from "convex/values";
import { SCENE_OVERRIDE_RANGES, validateSceneOverrides, type SceneOverrideKey } from "@forksafe/contracts";
import { mutation, query } from "./_generated/server.js";
import { requireInvestigationRead, requireOperateIdentity } from "./lib/webAccess.js";
import { assertUUID } from "./lib/validators.js";

/** A requested case waiting for a real physics run. This does not write an evaluation. */

function assertFallbackOverrides(overrides: Record<string, number>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(SCENE_OVERRIDE_RANGES, key)) {
      throw new ConvexError(`Unknown scene override "${key}".`);
    }
    const range = SCENE_OVERRIDE_RANGES[key as SceneOverrideKey];
    if (!Number.isFinite(value)) throw new ConvexError(`${range.label} must be a number.`);
    const epsilon = 1e-9;
    if (value < range.min - epsilon || value > range.max + epsilon) {
      throw new ConvexError(`${range.label} must stay inside the recorded range.`);
    }
  }
}

export const list = query({
  args: { investigationId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireInvestigationRead(ctx, args.investigationId, args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const rows = await ctx.db.query("challengeRequests")
      .withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId))
      .collect();
    return rows
      .map((row) => ({
        id: row._id,
        investigationId: row.investigationId,
        candidateId: row.candidateId,
        caseId: row.caseId,
        seed: row.seed,
        sceneOverrides: row.sceneOverrides,
        note: row.note,
        requestedBy: row.requestedBy,
        createdAtMs: row.createdAtMs,
        status: row.status,
      }))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  },
});

export const add = mutation({
  args: {
    investigationId: v.string(),
    candidateId: v.string(),
    seed: v.number(),
    sceneOverrides: v.record(v.string(), v.number()),
    note: v.string(),
    serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const requestedBy = await requireOperateIdentity(ctx, args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    assertUUID(args.candidateId, "candidateId");
    const note = args.note.trim();
    if (note.length < 1 || note.length > 280) throw new ConvexError("Note must be between 1 and 280 characters.");
    if (!Number.isInteger(args.seed) || args.seed < 0) throw new ConvexError("Seed must be a whole number.");
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation) throw new ConvexError("investigation_not_found");
    const candidate = await ctx.db.query("candidates")
      .withIndex("by_appId", (q) => q.eq("appId", args.candidateId))
      .unique();
    if (!candidate || candidate.investigationId !== investigation.appId) throw new ConvexError("candidate_not_found");
    const taskFamily = investigation.taskFamily ?? investigation.baselineCase.taskFamily;
    if (typeof taskFamily === "string" && taskFamily.length > 0) {
      const validation = validateSceneOverrides(taskFamily, args.sceneOverrides);
      if (!validation.ok) throw new ConvexError(validation.reason);
    } else {
      assertFallbackOverrides(args.sceneOverrides);
    }
    const createdAtMs = Date.now();
    const caseId = `challenge-${createdAtMs}`;
    await ctx.db.insert("challengeRequests", {
      investigationId: args.investigationId,
      candidateId: args.candidateId,
      caseId,
      seed: args.seed,
      sceneOverrides: args.sceneOverrides,
      note,
      requestedBy,
      createdAtMs,
      status: "pending_physics",
    });
    return { caseId, status: "pending_physics" as const, createdAtMs };
  },
});
