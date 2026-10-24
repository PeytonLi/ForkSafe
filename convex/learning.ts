import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { hasPrivateAccess, requireInvestigationRead, requireWriteIdentity } from "./lib/webAccess.js";
import { appId, assertUUID } from "./lib/validators.js";

export const DEFAULT_TASK_FAMILY = "divider_pick_place";

export function familyOf(investigation: { taskFamily?: string }): string {
  return investigation.taskFamily ?? DEFAULT_TASK_FAMILY;
}

export async function currentControllerForFamily(ctx: any, family: string): Promise<{
  version: number;
  controllerSha256: string;
  lineageId?: string;
  source: "approved" | "baseline";
} | null> {
  const lineage = await ctx.db.query("controllerLineage")
    .withIndex("by_family_version", (q: any) => q.eq("taskFamily", family))
    .order("desc")
    .first();
  if (lineage) return {
    version: lineage.version,
    controllerSha256: lineage.controllerSha256,
    lineageId: lineage.appId,
    source: "approved",
  };
  const baseline = await ctx.db.query("bundles").withIndex("by_key", (q: any) => q.eq("key", "baseline_controller")).unique();
  return baseline ? { version: 1, controllerSha256: baseline.sha256, source: "baseline" } : null;
}

export async function promoteOnApproval(ctx: any, review: any): Promise<any> {
  const existingReview = await ctx.db.query("controllerLineage")
    .withIndex("by_review", (q: any) => q.eq("reviewId", review.appId))
    .unique();
  if (existingReview) return existingReview;

  const investigation = await ctx.db.query("investigations")
    .withIndex("by_appId", (q: any) => q.eq("appId", review.investigationId))
    .unique();
  const candidate = await ctx.db.query("candidates")
    .withIndex("by_appId", (q: any) => q.eq("appId", review.candidateId))
    .unique();
  if (!investigation || !candidate) return { promoted: false, reason: "candidate_missing" };

  const family = familyOf(investigation);
  const sameSha = await ctx.db.query("controllerLineage")
    .withIndex("by_family_sha", (q: any) => q.eq("taskFamily", family).eq("controllerSha256", review.controllerSha256))
    .unique();
  if (sameSha) return sameSha;

  const source = await ctx.db.query("controllerSources")
    .withIndex("by_sha", (q: any) => q.eq("controllerSha256", review.controllerSha256))
    .unique();
  if (!source) return { promoted: false, reason: "source_missing" };

  const parent = await currentControllerForFamily(ctx, family);
  if (!parent) return { promoted: false, reason: "baseline_missing" };
  const row = {
    appId: appId(),
    taskFamily: family,
    version: parent.version + 1,
    controllerSha256: review.controllerSha256,
    parentControllerSha256: parent.controllerSha256,
    investigationId: investigation.appId,
    candidateId: candidate.appId,
    evaluationId: review.evaluationId,
    reviewId: review.appId,
    approvedBy: review.reviewerIdentity,
    spacetimeCommitted: false,
    createdAtMs: review.createdAtMs ?? Date.now(),
  };
  await ctx.db.insert("controllerLineage", row);
  return row;
}

export async function selectPriorHints(ctx: any, investigation: any, limit = 5): Promise<{
  findingId: string;
  sourceInvestigationId: string;
  sourceTitle: string;
  kind: string;
  summary: string;
}[]> {
  const family = familyOf(investigation);
  const eligibleInvestigations = (await ctx.db.query("investigations").collect())
    .filter((row: any) => row.appId !== investigation.appId
      && familyOf(row) === family
      && ["awaiting_review", "completed"].includes(row.state))
    .sort((a: any, b: any) => b.createdAtMs - a.createdAtMs)
    .slice(0, 20);
  const lineage = await ctx.db.query("controllerLineage")
    .withIndex("by_family_version", (q: any) => q.eq("taskFamily", family))
    .collect();
  const approvedShas = new Set(lineage.map((row: any) => row.controllerSha256));
  const approvedFindingIds = new Set<string>();
  for (const sourceInvestigation of eligibleInvestigations) {
    const candidates = await ctx.db.query("candidates")
      .withIndex("by_investigation", (q: any) => q.eq("investigationId", sourceInvestigation.appId))
      .collect();
    for (const candidate of candidates) {
      if (approvedShas.has(candidate.controllerSha256)) {
        for (const findingId of candidate.basedOnFindings ?? []) approvedFindingIds.add(findingId);
      }
    }
  }
  const kindRank: Record<string, number> = {
    candidate_hypothesis: 0,
    collision_frame: 1,
    cross_environment_pattern: 2,
    limit_violation: 3,
    behavioral_note: 4,
  };
  const pool = [];
  for (const sourceInvestigation of eligibleInvestigations) {
    const findings = await ctx.db.query("findings")
      .withIndex("by_investigation", (q: any) => q.eq("investigationId", sourceInvestigation.appId))
      .collect();
    for (const finding of findings) {
      pool.push({
        findingId: finding.appId,
        sourceInvestigationId: sourceInvestigation.appId,
        sourceTitle: sourceInvestigation.title,
        kind: finding.kind,
        summary: finding.summary.trim().slice(0, 280),
        approvedFixCited: approvedFindingIds.has(finding.appId),
        createdAtMs: finding.createdAtMs,
      });
    }
  }
  pool.sort((a: any, b: any) =>
    Number(b.approvedFixCited) - Number(a.approvedFixCited)
    || (kindRank[a.kind] ?? Number.MAX_SAFE_INTEGER) - (kindRank[b.kind] ?? Number.MAX_SAFE_INTEGER)
    || b.createdAtMs - a.createdAtMs);
  const seen = new Set<string>();
  return pool.filter((finding: any) => {
    if (!finding.summary || seen.has(finding.summary)) return false;
    seen.add(finding.summary);
    return true;
  }).slice(0, Math.min(5, Math.max(0, limit))).map(({ findingId, sourceInvestigationId, sourceTitle, kind, summary }: any) => ({
    findingId, sourceInvestigationId, sourceTitle, kind, summary,
  }));
}

export const markPromotionCommitted = internalMutation({
  args: { lineageId: v.string(), committed: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("controllerLineage")
      .withIndex("by_appId", (q) => q.eq("appId", args.lineageId))
      .unique();
    if (!row) return { updated: false };
    await ctx.db.patch(row._id, { spacetimeCommitted: args.committed });
    return { updated: true };
  },
});

function experimentSummary(row: any) {
  if (!row) return null;
  return {
    experimentId: row.appId,
    status: row.status,
    completed: row.completed,
    ...(row.completionTimeSec !== undefined ? { completionTimeSec: row.completionTimeSec } : {}),
    ...(row.firstFailure ? { firstFailure: row.firstFailure } : {}),
    failureKinds: row.failureKinds ?? [],
    ...(row.replayArtifactId ? { replayArtifactId: row.replayArtifactId } : {}),
    controllerSha256: row.controllerSha256,
  };
}

export function retryGate(state: string, current: any, thisRunSha: string | null) {
  if (!["awaiting_review", "completed"].includes(state)) return "Retry opens once the investigation is awaiting review.";
  if (!current || current.version < 2) return "No fix has been approved for this task yet.";
  if (current.controllerSha256 === thisRunSha) return "This run already used the newest approved controller.";
  return null;
}

export function retryIdempotencyKey(investigationId: string, controllerSha256: string): string {
  return `retry:${investigationId}:${controllerSha256}`;
}

export const view = query({
  args: { investigationId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireInvestigationRead(ctx, args.investigationId, args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const investigation = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!investigation) throw new ConvexError("investigation not found");
    const family = familyOf(investigation);
    const [baseline, lineageRows, baselineExperiment, offered] = await Promise.all([
      ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", "baseline_controller")).unique(),
      ctx.db.query("controllerLineage").withIndex("by_family_version", (q) => q.eq("taskFamily", family)).collect(),
      ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", investigation.baselineExperimentId)).unique(),
      ctx.db.query("priorHintOffers").withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId)).collect(),
    ]);
    const lineage = [];
    if (baseline) lineage.push({
      version: 1,
      controllerSha256: baseline.sha256,
      label: "Original baseline",
    });
    const orderedLineage = lineageRows.sort((a, b) => a.version - b.version);
    for (const row of orderedLineage) {
      const [sourceInvestigation, review] = await Promise.all([
        ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", row.investigationId)).unique(),
        ctx.db.query("reviews").withIndex("by_appId", (q) => q.eq("appId", row.reviewId)).unique(),
      ]);
      lineage.push({
        version: row.version,
        controllerSha256: row.controllerSha256,
        label: `Fix approved in ${sourceInvestigation?.title ?? "investigation"}`,
        investigationId: row.investigationId,
        investigationTitle: sourceInvestigation?.title ?? "Investigation",
        candidateId: row.candidateId,
        ...(review ? { approvedAtMs: review.createdAtMs } : {}),
      });
    }
    const current = await currentControllerForFamily(ctx, family);
    const thisRunSha = investigation.controllerSha256 ?? baselineExperiment?.controllerSha256 ?? null;
    const runLineage = thisRunSha
      ? orderedLineage.find((row) => row.controllerSha256 === thisRunSha)
      : undefined;
    const thisRunVersion = runLineage?.version ?? (baseline?.sha256 === thisRunSha ? 1 : null);
    const choice = investigation.controllerChoice
      ?? (thisRunSha && baseline?.sha256 === thisRunSha ? "baseline" : runLineage ? "approved" : null);
    const gate = retryGate(investigation.state, current, thisRunSha);
    const retries = await ctx.db.query("investigations")
      .withIndex("by_retryOf", (q) => q.eq("retryOfInvestigationId", investigation.appId))
      .collect();
    const latestRetry = retries.sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    let latest;
    if (latestRetry) {
      const after = await ctx.db.query("experiments")
        .withIndex("by_appId", (q) => q.eq("appId", latestRetry.baselineExperimentId))
        .unique();
      latest = {
        investigationId: latestRetry.appId,
        state: latestRetry.state,
        captureStatus: latestRetry.captureStatus ?? null,
        controllerSha256: latestRetry.controllerSha256 ?? null,
        controllerVersion: latestRetry.controllerVersion ?? null,
        before: experimentSummary(baselineExperiment),
        after: experimentSummary(after),
      };
    }
    const environments = await ctx.db.query("environments")
      .withIndex("by_investigation", (q) => q.eq("investigationId", investigation.appId))
      .collect();
    const environmentIds = new Set(environments.map((row) => row.appId));
    const usedFindingIds = new Set<string>();
    for (const offer of offered) {
      const uses = await ctx.db.query("findingUses")
        .withIndex("by_finding", (q) => q.eq("findingId", offer.findingId))
        .collect();
      if (uses.some((use) => use.crossRun && environmentIds.has(use.usedByEnvironmentId))) usedFindingIds.add(offer.findingId);
    }
    const priorHints = [];
    for (const offer of offered.sort((a, b) => a.rank - b.rank)) {
      const source = await ctx.db.query("investigations")
        .withIndex("by_appId", (q) => q.eq("appId", offer.sourceInvestigationId))
        .unique();
      priorHints.push({
        findingId: offer.findingId,
        sourceInvestigationId: offer.sourceInvestigationId,
        sourceTitle: source?.title ?? "Earlier investigation",
        summary: offer.summary,
        used: usedFindingIds.has(offer.findingId),
      });
    }
    return {
      taskFamily: family,
      lineage,
      current: current ? { version: current.version, controllerSha256: current.controllerSha256 } : null,
      thisRun: {
        controllerSha256: thisRunSha,
        version: thisRunVersion,
        choice,
      },
      retry: {
        available: !gate,
        ...(gate ? { reason: gate } : {}),
        ...(latest ? { latest } : {}),
      },
      priorHints,
    };
  },
});

export const retry = mutation({
  args: { investigationId: v.string(), idempotencyKey: v.optional(v.string()), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ accepted: true; investigationId: string } | { accepted: false; mode: string; reason: string }> => {
    await requireWriteIdentity(ctx, args.serviceToken);
    assertUUID(args.investigationId, "investigationId");
    const source = await ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", args.investigationId))
      .unique();
    if (!source) throw new ConvexError("investigation_not_found");
    const family = familyOf(source);
    const current = await currentControllerForFamily(ctx, family);
    const sourceExperiment = await ctx.db.query("experiments")
      .withIndex("by_appId", (q) => q.eq("appId", source.baselineExperimentId))
      .unique();
    const thisRunSha = source.controllerSha256 ?? sourceExperiment?.controllerSha256 ?? null;
    const reason = retryGate(source.state, current, thisRunSha);
    if (reason) return { accepted: false, mode: "live", reason };
    const idempotencyKey = args.idempotencyKey ?? retryIdempotencyKey(source.appId, current!.controllerSha256);
    const existing = await ctx.db.query("investigations")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", idempotencyKey))
      .unique();
    if (existing) return { accepted: true, investigationId: existing.appId };
    if (process.env.DAYTONA_MODE !== "cloud" || !process.env.DAYTONA_API_KEY) {
      return {
        accepted: false,
        mode: process.env.DAYTONA_MODE === "local" ? "local" : "blocked",
        reason: "capture needs a Daytona execution sandbox; DAYTONA_API_KEY is not configured",
      };
    }
    const simulator = await ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", "simulator")).unique();
    const baseline = await ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", "baseline_controller")).unique();
    if (!simulator || !baseline) {
      return { accepted: false, mode: "blocked", reason: "simulator bundle not published (run apps/runner publish-bundles)" };
    }
    const now = Date.now();
    const investigationId = appId();
    const baselineExperimentId = appId();
    await ctx.db.insert("investigations", {
      appId: investigationId,
      title: `Retry with v${current!.version}: ${source.title}`.slice(0, 200),
      state: "capturing",
      cancelStatus: "none",
      cancelEpoch: 0,
      version: 1,
      requestedEnvironments: 1,
      baselineCase: source.baselineCase,
      baselineExperimentId,
      budget: source.budget,
      idempotencyKey,
      captureStatus: "pending",
      autoStart: false,
      taskFamily: family,
      controllerSha256: current!.controllerSha256,
      controllerVersion: current!.version,
      controllerChoice: "approved",
      retryOfInvestigationId: source.appId,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await ctx.scheduler.runAfter(0, internal.capture.run, { investigationId });
    return { accepted: true, investigationId };
  },
});

export const currentController = query({
  args: { taskFamily: v.optional(v.string()), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const privateAccess = await hasPrivateAccess(ctx, args.serviceToken);
    const taskFamily = args.taskFamily ?? DEFAULT_TASK_FAMILY;
    const [current, baseline] = await Promise.all([
      currentControllerForFamily(ctx, taskFamily),
      ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", "baseline_controller")).unique(),
    ]);
    const lineage = current?.lineageId
      ? await ctx.db.query("controllerLineage").withIndex("by_appId", (q) => q.eq("appId", current.lineageId!)).unique()
      : null;
    const sourceInvestigation = lineage
      ? await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", lineage.investigationId)).unique()
      : null;
    return {
      taskFamily,
      approved: current?.source === "approved" ? {
        version: current.version,
        controllerSha256: current.controllerSha256,
        ...(privateAccess && sourceInvestigation ? { investigationTitle: sourceInvestigation.title } : {}),
      } : null,
      baseline: baseline ? { version: 1, controllerSha256: baseline.sha256 } : null,
    };
  },
});
