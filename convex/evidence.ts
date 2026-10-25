import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server.js";
import { requireInvestigationRead } from "./lib/webAccess.js";
import { appId, assertUUID } from "./lib/validators.js";

/** Bridge projection writes. SpacetimeDB is written first by the bridge
 *  actions; these mutations keep the Convex projection the web app reads.
 *  Every insert is keyed by the durable application id, so retries no-op. */

const simCase = v.object({
  caseId: v.string(), suite: v.union(v.literal("original"), v.literal("public"), v.literal("withheld")),
  seed: v.number(), sceneOverrides: v.record(v.string(), v.number()), taskFamily: v.optional(v.string()), description: v.optional(v.string()),
});

export const reserveExperiment = internalMutation({
  args: {
    experimentId: v.string(), investigationId: v.string(), environmentId: v.optional(v.string()),
    attemptId: v.string(), epoch: v.number(), grantId: v.optional(v.string()),
    purpose: v.union(v.literal("baseline"), v.literal("development"), v.literal("evaluation")),
    simCase, controllerSha256: v.string(), revisionId: v.optional(v.string()), candidateId: v.optional(v.string()),
    hypothesis: v.optional(v.string()), sandboxOpId: v.optional(v.string()), changedFunctions: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertUUID(args.experimentId, "experimentId");
    const existing = await ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", args.experimentId)).unique();
    if (existing) return { duplicate: true };
    if (args.purpose === "development") {
      if (!args.environmentId) throw new ConvexError("environment_required");
      if (args.simCase.suite !== "public" && args.simCase.suite !== "original") throw new ConvexError("case_not_public");
      const environmentId = args.environmentId;
      const environment = await ctx.db.query("environments").withIndex("by_appId", (q) => q.eq("appId", environmentId)).unique();
      if (!environment) throw new ConvexError("environment_not_found");
      if (environment.experimentsUsed >= environment.budgets.maxExperiments) throw new ConvexError("experiment_budget_exhausted");
      await ctx.db.patch(environment._id, { experimentsUsed: environment.experimentsUsed + 1 });
    }
    await ctx.db.insert("experiments", {
      appId: args.experimentId, investigationId: args.investigationId,
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      ...(args.candidateId ? { candidateId: args.candidateId } : {}),
      ...(args.revisionId ? { revisionId: args.revisionId } : {}),
      attemptId: args.attemptId, epoch: args.epoch, ...(args.grantId ? { grantId: args.grantId } : {}),
      purpose: args.purpose, suite: args.simCase.suite, simCase: args.simCase, status: "running",
      failureKinds: [], completed: false, changedFunctions: args.changedFunctions, engineVersion: "pending",
      assetsSha256: "0".repeat(64), controllerSha256: args.controllerSha256,
      ...(args.hypothesis ? { hypothesis: args.hypothesis } : {}),
      ...(args.sandboxOpId ? { sandboxOpId: args.sandboxOpId } : {}),
      spacetimeCommitted: false, startedAtMs: Date.now(),
    });
    return { duplicate: false };
  },
});

export const finishExperiment = internalMutation({
  args: {
    experimentId: v.string(),
    status: v.union(v.literal("succeeded"), v.literal("physics_failure"), v.literal("constraint_violation"), v.literal("engine_error"), v.literal("invalid"), v.literal("cancelled")),
    failureKinds: v.array(v.string()), completed: v.boolean(), completionTimeSec: v.optional(v.number()),
    firstFailure: v.optional(v.object({ kind: v.string(), tSec: v.number(), detail: v.string() })),
    engineVersion: v.string(), assetsSha256: v.string(), controllerSha256: v.string(),
    traceArtifactId: v.optional(v.string()), replayArtifactId: v.optional(v.string()), spacetimeCommitted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", args.experimentId)).unique();
    if (!row) throw new ConvexError("experiment_not_found");
    const { experimentId, spacetimeCommitted, ...rest } = args;
    await ctx.db.patch(row._id, {
      ...rest,
      ...(spacetimeCommitted !== undefined ? { spacetimeCommitted } : {}),
      finishedAtMs: row.finishedAtMs ?? Date.now(),
    });
    return { updated: true };
  },
});

export const markCommitted = internalMutation({
  args: { table: v.union(v.literal("experiments"), v.literal("findings"), v.literal("candidates"), v.literal("evaluations"), v.literal("reviews"), v.literal("controllerRevisions")), appId: v.string(), committed: v.boolean() },
  handler: async (ctx, args) => {
    const row = await (ctx.db.query(args.table) as any).withIndex("by_appId", (q: any) => q.eq("appId", args.appId)).unique();
    if (!row) return { updated: false };
    await ctx.db.patch(row._id, { spacetimeCommitted: args.committed });
    return { updated: true };
  },
});

export const getExperiment = internalQuery({
  args: { experimentId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", args.experimentId)).unique(),
});

const evidenceItem = v.object({
  kind: v.union(v.literal("trace_frame"), v.literal("contact_event"), v.literal("metric"), v.literal("log_excerpt"), v.literal("code_diff"), v.literal("replay_segment")),
  artifactId: v.optional(v.string()), experimentId: v.optional(v.string()), locator: v.any(), excerpt: v.optional(v.string()),
});

export const insertFinding = internalMutation({
  args: {
    findingId: v.string(), investigationId: v.string(), environmentId: v.string(), sessionId: v.optional(v.string()),
    attemptId: v.string(), epoch: v.number(), grantId: v.optional(v.string()),
    kind: v.union(v.literal("collision_frame"), v.literal("limit_violation"), v.literal("behavioral_note"), v.literal("candidate_hypothesis"), v.literal("cross_environment_pattern")),
    claim: v.union(v.literal("observation"), v.literal("inference")), summary: v.string(), evidence: v.array(evidenceItem),
  },
  handler: async (ctx, args) => {
    assertUUID(args.findingId, "findingId");
    const existing = await ctx.db.query("findings").withIndex("by_appId", (q) => q.eq("appId", args.findingId)).unique();
    if (existing) return { duplicate: true };
    if (!args.summary.trim() || args.summary.length > 2000) throw new ConvexError("summary_invalid");
    for (const item of args.evidence) {
      if (item.experimentId) {
        const experiment = await ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", item.experimentId!)).unique();
        if (!experiment || experiment.investigationId !== args.investigationId) throw new ConvexError("evidence_experiment_unknown");
      }
      if (item.excerpt && item.excerpt.length > 4000) throw new ConvexError("excerpt_too_long");
    }
    const { findingId, ...rest } = args;
    await ctx.db.insert("findings", { appId: findingId, ...rest, spacetimeCommitted: false, createdAtMs: Date.now() });
    return { duplicate: false };
  },
});

export const commitRevision = internalMutation({
  args: {
    revisionId: v.string(), investigationId: v.string(), environmentId: v.string(), attemptId: v.string(), epoch: v.number(),
    grantId: v.optional(v.string()), controllerSha256: v.string(), sourceArtifactId: v.string(), source: v.string(),
    changedFunctions: v.array(v.string()), rationale: v.optional(v.string()), expectedHeadRevisionId: v.optional(v.string()),
    basedOnFindings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    assertUUID(args.revisionId, "revisionId");
    const existing = await ctx.db.query("controllerRevisions").withIndex("by_appId", (q) => q.eq("appId", args.revisionId)).unique();
    if (existing) return { duplicate: true, seq: existing.seq, headRevisionId: existing.appId };
    const revisions = await ctx.db.query("controllerRevisions").withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId)).collect();
    const head = revisions.sort((a, b) => b.seq - a.seq)[0];
    if ((head?.appId) !== args.expectedHeadRevisionId) throw new ConvexError("revision_conflict");
    const now = Date.now();
    const source = await ctx.db.query("controllerSources").withIndex("by_sha", (q) => q.eq("controllerSha256", args.controllerSha256)).unique();
    if (!source) {
      await ctx.db.insert("controllerSources", {
        controllerSha256: args.controllerSha256, investigationId: args.investigationId, artifactId: args.sourceArtifactId,
        source: args.source, bytes: new TextEncoder().encode(args.source).byteLength, createdAtMs: now,
      });
    }
    const seq = (head?.seq ?? 0) + 1;
    await ctx.db.insert("controllerRevisions", {
      appId: args.revisionId, investigationId: args.investigationId, environmentId: args.environmentId, seq,
      ...(head ? { parentRevisionId: head.appId } : {}), controllerSha256: args.controllerSha256,
      sourceArtifactId: args.sourceArtifactId, changedFunctions: args.changedFunctions,
      ...(args.rationale ? { rationale: args.rationale } : {}),
      ...(args.basedOnFindings?.length ? { basedOnFindings: [...new Set(args.basedOnFindings)] } : {}),
      createdByAttemptId: args.attemptId, epoch: args.epoch,
      ...(args.grantId ? { grantId: args.grantId } : {}), spacetimeCommitted: false, createdAtMs: now,
    });
    return { duplicate: false, seq, headRevisionId: args.revisionId };
  },
});

export const environmentHead = internalQuery({
  args: { environmentId: v.string() },
  handler: async (ctx, args) => {
    const revisions = await ctx.db.query("controllerRevisions").withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId)).collect();
    return revisions.sort((a, b) => b.seq - a.seq)[0] ?? null;
  },
});

export const getRevision = internalQuery({
  args: { revisionId: v.string() },
  handler: async (ctx, args) => {
    const revision = await ctx.db.query("controllerRevisions").withIndex("by_appId", (q) => q.eq("appId", args.revisionId)).unique();
    if (!revision) return null;
    const source = await ctx.db.query("controllerSources").withIndex("by_sha", (q) => q.eq("controllerSha256", revision.controllerSha256)).unique();
    return { revision, source: source?.source ?? null };
  },
});

export const getSourceBySha = internalQuery({
  args: { controllerSha256: v.string() },
  handler: async (ctx, args) => await ctx.db.query("controllerSources").withIndex("by_sha", (q) => q.eq("controllerSha256", args.controllerSha256)).unique(),
});

export const insertCandidate = internalMutation({
  args: {
    candidateId: v.string(), investigationId: v.string(), environmentId: v.string(), revisionId: v.string(),
    attemptId: v.string(), epoch: v.number(), grantId: v.optional(v.string()), rationale: v.optional(v.string()), basedOnFindings: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertUUID(args.candidateId, "candidateId");
    const existing = await ctx.db.query("candidates").withIndex("by_appId", (q) => q.eq("appId", args.candidateId)).unique();
    if (existing) return { duplicate: true, candidate: existing };
    const environment = await ctx.db.query("environments").withIndex("by_appId", (q) => q.eq("appId", args.environmentId)).unique();
    if (!environment) throw new ConvexError("environment_not_found");
    if (environment.candidatesUsed >= environment.budgets.maxCandidates) throw new ConvexError("candidate_budget_exhausted");
    const revision = await ctx.db.query("controllerRevisions").withIndex("by_appId", (q) => q.eq("appId", args.revisionId)).unique();
    if (!revision || revision.environmentId !== args.environmentId) throw new ConvexError("revision_mismatch");
    const siblings = await ctx.db.query("candidates").withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId)).collect();
    if (siblings.some((row) => row.controllerSha256 === revision.controllerSha256)) throw new ConvexError("candidate_duplicate_sha");
    for (const findingId of args.basedOnFindings) {
      assertUUID(findingId, "findingId");
      const finding = await ctx.db.query("findings").withIndex("by_appId", (q) => q.eq("appId", findingId)).unique();
      if (!finding) throw new ConvexError("finding_missing");
      // Cross-run citations are allowed when the finding was offered to this environment as a prior hint.
      if (finding.investigationId !== args.investigationId) {
        const offer = await ctx.db.query("priorHintOffers").withIndex("by_environment_finding", (q) =>
          q.eq("environmentId", args.environmentId).eq("findingId", findingId)).unique();
        if (!offer) throw new ConvexError("finding_missing");
      }
    }
    const now = Date.now();
    await ctx.db.patch(environment._id, { candidatesUsed: environment.candidatesUsed + 1 });
    const row = {
      appId: args.candidateId, investigationId: args.investigationId, environmentId: args.environmentId, revisionId: args.revisionId,
      status: "submitted" as const, controllerSha256: revision.controllerSha256, sourceArtifactId: revision.sourceArtifactId,
      changedFunctions: revision.changedFunctions, ...(args.rationale ? { rationale: args.rationale } : {}),
      basedOnFindings: args.basedOnFindings, submittedByAttemptId: args.attemptId, epoch: args.epoch,
      ...(args.grantId ? { grantId: args.grantId } : {}), spacetimeCommitted: false, submittedAtMs: now, updatedAtMs: now,
    };
    await ctx.db.insert("candidates", row);
    return { duplicate: false, candidate: row };
  },
});

function toContractFinding(row: any) {
  return {
    id: row.appId, investigationId: row.investigationId, environmentId: row.environmentId,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}), kind: row.kind, summary: row.summary,
    evidence: row.evidence.map((item: any) => ({
      kind: item.kind, ...(item.artifactId ? { artifactId: item.artifactId } : {}),
      ...(item.experimentId ? { experimentId: item.experimentId } : {}), locator: item.locator ?? {},
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    })),
    createdAtMs: row.createdAtMs,
  };
}

/** Web: `evidence:findings`, newest first. */
export const findings = query({
  args: { investigationId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireInvestigationRead(ctx, args.investigationId, args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const rows = await ctx.db.query("findings").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    return rows.sort((a, b) => b.createdAtMs - a.createdAtMs).map(toContractFinding);
  },
});

/** Runner tool: findings for the environment or the whole investigation. */
export const findingsForTool = internalQuery({
  args: { investigationId: v.string(), environmentId: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = args.environmentId
      ? await ctx.db.query("findings").withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId!)).collect()
      : await ctx.db.query("findings").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    return rows.filter((row) => row.investigationId === args.investigationId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, Math.min(50, Math.max(1, args.limit)))
      .map((row) => ({ ...toContractFinding(row), claim: row.claim, trust: "untrusted_peer_finding" }));
  },
});

export const experimentsForTool = internalQuery({
  args: { investigationId: v.string(), experimentId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = args.experimentId
      ? [await ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", args.experimentId!)).unique()].filter(Boolean)
      : await ctx.db.query("experiments").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    return rows.filter((row: any) => row.investigationId === args.investigationId && row.suite !== "withheld").map((row: any) => ({
      experimentId: row.appId, environmentId: row.environmentId, purpose: row.purpose, caseId: row.simCase.caseId, seed: row.simCase.seed,
      status: row.status, failureKinds: row.failureKinds, completed: row.completed, completionTimeSec: row.completionTimeSec,
      firstFailure: row.firstFailure, controllerSha256: row.controllerSha256, revisionId: row.revisionId, replayArtifactId: row.replayArtifactId,
      hypothesis: row.hypothesis, startedAtMs: row.startedAtMs, finishedAtMs: row.finishedAtMs,
    }));
  },
});

export const newId = () => appId();
