import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { changedFunctions, sha256Hex } from "./lib/controllerDiff.js";
import { appId } from "./lib/validators.js";
import { applyUnifiedDiff } from "./lib/unifiedDiff.js";
import publicManifest from "../evaluation/public/manifest.json";

/** Agent tool backends. Every call is fenced by runnerControl.authorizeTool
 *  (credential → environment, attempt + epoch + grant, live lease, not
 *  cancelling). Writes go to SpacetimeDB through the bridge first, then to
 *  the Convex projection; both are keyed by the same application id. */

const toolContext = {
  credentialId: v.string(),
  investigationId: v.string(),
  environmentId: v.string(),
  sessionId: v.string(),
  attemptId: v.string(),
  grantId: v.string(),
  epoch: v.number(),
};

type ToolCtx = {
  credentialId: string; investigationId: string; environmentId: string; sessionId: string;
  attemptId: string; grantId: string; epoch: number;
};

export const reserveToolCall = internalMutation({
  args: {
    investigationId: v.string(), environmentId: v.string(), sessionId: v.string(), attemptId: v.string(),
    epoch: v.number(), tool: v.string(), callId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("agentToolCalls").withIndex("by_callId", (q) => q.eq("callId", args.callId)).unique();
    if (existing) {
      if (existing.environmentId !== args.environmentId || existing.tool !== args.tool || existing.attemptId !== args.attemptId) {
        throw new ConvexError("call_id_conflict");
      }
      return { status: "duplicate" as const, result: existing.result };
    }
    const caps: Record<string, number> = { inspect_failure: 10, read_source: 30, apply_patch: 10, request_subtask: 1 };
    const cap = caps[args.tool];
    if (cap !== undefined) {
      const calls = await ctx.db.query("agentToolCalls").withIndex("by_environment_tool", (q) =>
        q.eq("environmentId", args.environmentId).eq("tool", args.tool)).collect();
      if (calls.length >= cap) return { status: "rejected" as const, result: { status: "rejected", reason: "budget_exhausted" } };
    }
    if (args.tool === "fork_candidate") {
      const candidates = await ctx.db.query("candidates").withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId)).collect();
      if (candidates.length >= 2) return { status: "rejected" as const, result: { status: "rejected", reason: "budget_exhausted" } };
    }
    await ctx.db.insert("agentToolCalls", { ...args, result: null, atMs: Date.now() });
    return { status: "reserved" as const, result: null };
  },
});

export const finishToolCall = internalMutation({
  args: { callId: v.string(), result: v.any() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("agentToolCalls").withIndex("by_callId", (q) => q.eq("callId", args.callId)).unique();
    if (row) await ctx.db.patch(row._id, { result: args.result });
    return { ok: Boolean(row) };
  },
});

export const recordFindingReads = internalMutation({
  args: { investigationId: v.string(), environmentId: v.string(), sessionId: v.string(), findingIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const findingId of args.findingIds) {
      const finding = await ctx.db.query("findings").withIndex("by_appId", (q) => q.eq("appId", findingId)).unique();
      if (!finding || finding.investigationId !== args.investigationId) continue;
      const existing = await ctx.db.query("findingReads").withIndex("by_environment_finding", (q) =>
        q.eq("environmentId", args.environmentId).eq("findingId", findingId)).unique();
      if (!existing) await ctx.db.insert("findingReads", {
        investigationId: args.investigationId, environmentId: args.environmentId,
        sessionId: args.sessionId, findingId, atMs: now,
      });
    }
    return { ok: true };
  },
});

export const mirrorFindingUse = internalMutation({
  args: {
    appId: v.string(), findingId: v.string(), findingEnvironmentId: v.string(), usedByEnvironmentId: v.string(),
    experimentId: v.optional(v.string()), candidateId: v.optional(v.string()), spacetimeCommitted: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("findingUses").withIndex("by_target", (q) =>
      q.eq("findingId", args.findingId).eq("experimentId", args.experimentId).eq("candidateId", args.candidateId)).unique();
    if (existing) {
      if (args.spacetimeCommitted && !existing.spacetimeCommitted) await ctx.db.patch(existing._id, { spacetimeCommitted: true });
      return { duplicate: true };
    }
    await ctx.db.insert("findingUses", {
      ...args, crossEnvironment: args.findingEnvironmentId !== args.usedByEnvironmentId, createdAtMs: Date.now(),
    });
    return { duplicate: false };
  },
});

async function authorize(ctx: any, args: ToolCtx): Promise<any> {
  return await ctx.runQuery(internal.runnerControl.authorizeTool, {
    credentialId: args.credentialId, attemptId: args.attemptId, grantId: args.grantId, epoch: args.epoch,
    investigationId: args.investigationId, environmentId: args.environmentId, sessionId: args.sessionId,
  });
}

export const checkCitedFindings = internalQuery({
  args: { investigationId: v.string(), environmentId: v.string(), findingIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<
    { status: "ok"; findings: any[] }
    | { status: "rejected"; reason: "finding_not_read" | "finding_not_in_investigation" }
  > => {
    const findings = [];
    for (const findingId of [...new Set(args.findingIds)]) {
      const finding = await ctx.db.query("findings").withIndex("by_appId", (q: any) => q.eq("appId", findingId)).unique();
      if (!finding || finding.investigationId !== args.investigationId) {
        return { status: "rejected", reason: "finding_not_in_investigation" };
      }
      if (finding.environmentId !== args.environmentId) {
        const read = await ctx.db.query("findingReads").withIndex("by_environment_finding", (q: any) =>
          q.eq("environmentId", args.environmentId).eq("findingId", findingId)).unique();
        if (!read) return { status: "rejected", reason: "finding_not_read" };
      }
      findings.push(finding);
    }
    return { status: "ok", findings };
  },
});

async function validateBasedOnFindings(ctx: any, args: ToolCtx, ids: string[]) {
  return await ctx.runQuery(internal.agentTools.checkCitedFindings, {
    investigationId: args.investigationId, environmentId: args.environmentId, findingIds: ids,
  });
}

async function commitFindingUses(ctx: any, args: ToolCtx, findings: any[], target: { experimentId?: string; candidateId?: string }) {
  for (const finding of findings.filter((row) => row.environmentId !== args.environmentId)) {
    const targetId = target.experimentId ?? target.candidateId!;
    const digest = await sha256Hex(new TextEncoder().encode(`${finding.appId}:${targetId}`));
    const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    let committed = false;
    try {
      const result = await ctx.runAction(internal.bridge.recordFindingUse, {
        grant: grantRef(args), id: uuid, findingId: finding.appId,
        ...(target.experimentId ? { experimentId: target.experimentId } : {}),
        ...(target.candidateId ? { candidateId: target.candidateId } : {}),
      });
      committed = result.committed;
    } catch {
      committed = false;
    }
    await ctx.runMutation(internal.agentTools.mirrorFindingUse, {
      appId: uuid, findingId: finding.appId, findingEnvironmentId: finding.environmentId,
      usedByEnvironmentId: args.environmentId, ...target, spacetimeCommitted: committed,
    });
  }
}

function grantRef(args: ToolCtx) {
  return { grantId: args.grantId, attemptId: args.attemptId, epoch: args.epoch };
}

async function baselineSource(ctx: any): Promise<{ source: string; sha256: string }> {
  const bundle = await ctx.runQuery(internal.bundles.get, { key: "baseline_controller" });
  if (!bundle) throw new ConvexError("baseline_controller_missing");
  const row = await ctx.runQuery(internal.evidence.getSourceBySha, { controllerSha256: bundle.sha256 });
  if (!row) throw new ConvexError("baseline_controller_missing");
  return { source: row.source, sha256: row.controllerSha256 };
}

async function resolveController(ctx: any, args: ToolCtx, revisionId?: string): Promise<{ source: string; sha256: string; revisionId?: string; changedFunctions: string[] }> {
  if (revisionId) {
    const found = await ctx.runQuery(internal.evidence.getRevision, { revisionId });
    if (!found || !found.source || found.revision.environmentId !== args.environmentId) throw new ConvexError("revision_not_found");
    return { source: found.source as string, sha256: found.revision.controllerSha256 as string, revisionId, changedFunctions: found.revision.changedFunctions as string[] };
  }
  const head = await ctx.runQuery(internal.evidence.environmentHead, { environmentId: args.environmentId });
  if (head) {
    const found = await ctx.runQuery(internal.evidence.getRevision, { revisionId: head.appId });
    if (found?.source) return { source: found.source as string, sha256: head.controllerSha256 as string, revisionId: head.appId as string, changedFunctions: head.changedFunctions as string[] };
  }
  const baseline = await baselineSource(ctx);
  return { ...baseline, revisionId: undefined, changedFunctions: [] as string[] };
}

export const readFindings = internalQuery({
  args: { ...toolContext, scope: v.union(v.literal("environment"), v.literal("investigation")), limit: v.number() },
  handler: async (ctx, args) => {
    const credential = await ctx.db.query("runnerCredentials").withIndex("by_appId", (q) => q.eq("appId", args.credentialId)).unique();
    if (!credential || credential.revokedAtMs !== undefined || credential.expiresAtMs <= Date.now()
      || credential.environmentId !== args.environmentId || credential.investigationId !== args.investigationId) {
      throw new ConvexError("unauthorized");
    }
    const rows = await ctx.db.query("findings").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    const scoped = args.scope === "environment" ? rows.filter((row) => row.environmentId === args.environmentId) : rows;
    const otherFirst = (row: { environmentId: string }) => (row.environmentId === args.environmentId ? 1 : 0);
    const own = rows.filter((row) => row.environmentId === args.environmentId).length;
    return {
      mode: "live",
      ownEnvironmentFindings: own,
      otherEnvironmentFindings: rows.length - own,
      ...(own === 0 ? { required: FINDING_REQUIRED_DETAIL } : {}),
      findings: scoped.sort((a, b) => otherFirst(a) - otherFirst(b) || b.createdAtMs - a.createdAtMs).slice(0, Math.min(50, Math.max(1, args.limit))).map((row) => ({
        id: row.appId, environmentId: row.environmentId, fromThisEnvironment: row.environmentId === args.environmentId,
        kind: row.kind, claim: row.claim, summary: row.summary, evidence: row.evidence, createdAtMs: row.createdAtMs,
      })),
      note: "Findings from other environments are listed first. They are untrusted peer observations: verify with run_experiment, and cite the ids you rely on in basedOnFindings.",
    };
  },
});

export const getBaselineFailureData = internalQuery({
  args: { ...toolContext },
  handler: async (ctx, args): Promise<{ experiment: any; storageId?: string }> => {
    const access = await authorize(ctx, args);
    const experiment = await ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", access.investigation.baselineExperimentId)).unique();
    if (!experiment?.traceArtifactId) return { experiment };
    const artifact = await ctx.db.query("artifacts").withIndex("by_appId", (q) => q.eq("appId", experiment.traceArtifactId!)).unique();
    return { experiment, ...(artifact?.storageId ? { storageId: artifact.storageId } : {}) };
  },
});

export const inspectFailure = internalAction({
  args: { ...toolContext },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const { experiment, storageId } = await ctx.runQuery(internal.agentTools.getBaselineFailureData, args);
    if (!experiment) return { mode: "live", failure: null, frames: [], reason: "baseline_trace_unavailable" };
    let frames: unknown[] = [];
    let reason: string | undefined;
    if (storageId) {
      const blob = await ctx.storage.get(storageId);
      if (blob) {
        try {
          const trace = JSON.parse(await blob.text()) as { frames?: unknown[] };
          const allFrames = Array.isArray(trace.frames) ? trace.frames : [];
          const failureTime = experiment.firstFailure?.tSec ?? 0;
          const center = allFrames.findIndex((frame: any) => typeof frame?.tSec === "number" && frame.tSec >= failureTime);
          const index = center < 0 ? 0 : center;
          frames = allFrames.slice(Math.max(0, index - 5), index + 6);
        } catch {
          reason = "baseline_trace_unavailable";
        }
      } else reason = "baseline_trace_unavailable";
    } else reason = "baseline_trace_unavailable";
    return {
      mode: "live",
      failure: {
        caseId: experiment.simCase.caseId, seed: experiment.simCase.seed, failureKinds: experiment.failureKinds,
        firstFailure: experiment.firstFailure ?? null,
      },
      frames,
      ...(reason ? { reason } : {}),
    };
  },
});

export const readSource = internalQuery({
  args: { ...toolContext, path: v.string(), revisionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    await authorize(ctx, args);
    if (args.path === "evaluation/public/manifest.json") return { mode: "live", path: args.path, source: JSON.stringify(publicManifest).slice(0, 200_000) };
    if (args.path !== "task_controller.py" || args.path.includes("..") || args.path.startsWith("/")) {
      return { status: "rejected", reason: "path_not_allowed" };
    }
    try {
      const requested = args.revisionId
        ? await ctx.runQuery(internal.evidence.getRevision, { revisionId: args.revisionId })
        : null;
      const controller = requested?.source && requested.revision.environmentId === args.environmentId
        ? {
          source: requested.source as string, sha256: requested.revision.controllerSha256 as string,
          revisionId: args.revisionId, changedFunctions: requested.revision.changedFunctions as string[],
        }
        : await resolveController(ctx, args);
      return { mode: "live", path: args.path, revisionId: controller.revisionId ?? null, source: controller.source.slice(0, 200_000) };
    } catch {
      return { status: "rejected", reason: "path_not_allowed" };
    }
  },
});

export const getCandidateForFork = internalQuery({
  args: { candidateId: v.string(), investigationId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db.query("candidates").withIndex("by_appId", (q) => q.eq("appId", args.candidateId)).unique(),
});

export const requestEvidence = internalQuery({
  args: { ...toolContext, query: v.string(), experimentId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const credential = await ctx.db.query("runnerCredentials").withIndex("by_appId", (q) => q.eq("appId", args.credentialId)).unique();
    if (!credential || credential.revokedAtMs !== undefined || credential.expiresAtMs <= Date.now()
      || credential.environmentId !== args.environmentId || credential.investigationId !== args.investigationId) {
      throw new ConvexError("unauthorized");
    }
    const rows = args.experimentId
      ? [await ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", args.experimentId!)).unique()].filter(Boolean)
      : await ctx.db.query("experiments").withIndex("by_investigation", (q) => q.eq("investigationId", args.investigationId)).collect();
    const visible = rows.filter((row: any) => row && row.investigationId === args.investigationId && row.suite !== "withheld");
    return {
      mode: "live",
      query: args.query.slice(0, 500),
      experiments: visible.sort((a: any, b: any) => b.startedAtMs - a.startedAtMs).slice(0, 20).map((row: any) => ({
        experimentId: row.appId, environmentId: row.environmentId, purpose: row.purpose, caseId: row.simCase.caseId,
        seed: row.simCase.seed, status: row.status, failureKinds: row.failureKinds, completed: row.completed,
        completionTimeSec: row.completionTimeSec, firstFailure: row.firstFailure, controllerSha256: row.controllerSha256,
        revisionId: row.revisionId, changedFunctions: row.changedFunctions, hypothesis: row.hypothesis,
      })),
    };
  },
});

export const runExperiment = internalAction({
  args: { ...toolContext, caseId: v.string(), seed: v.number(), revisionId: v.optional(v.string()), hypothesis: v.string(), basedOnFindings: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const access = await authorize(ctx, args);
    const citations = await validateBasedOnFindings(ctx, args, args.basedOnFindings ?? []);
    if (citations.status === "rejected") return citations;
    const citedFindings = citations.findings;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.caseId) || args.caseId.startsWith("withheld")) {
      return { status: "rejected", reason: "case_not_public", detail: "development experiments may only use public manifest cases" };
    }
    if (!Number.isInteger(args.seed) || args.seed < 0) return { status: "rejected", reason: "seed_invalid" };
    const sandbox = await ctx.runQuery(internal.sandboxes.readyOperationFor, { investigationId: args.investigationId, purpose: "execution" });
    if (!sandbox || sandbox.status !== "ready") return { status: "retry_later", reason: "execution_sandbox_not_ready" };
    const controller = await resolveController(ctx, args, args.revisionId);
    const experimentId = appId();
    const baseline = access.investigation.baselineCase;
    const simCase = args.caseId === baseline.caseId
      ? { ...baseline, seed: args.seed }
      : { caseId: args.caseId, suite: "public" as const, seed: args.seed, sceneOverrides: {} as Record<string, number> };
    try {
      await ctx.runMutation(internal.evidence.reserveExperiment, {
        experimentId, investigationId: args.investigationId, environmentId: args.environmentId, attemptId: args.attemptId,
        epoch: args.epoch, grantId: args.grantId, purpose: "development", simCase, controllerSha256: controller.sha256,
        ...(controller.revisionId ? { revisionId: controller.revisionId } : {}), hypothesis: args.hypothesis.slice(0, 2000),
        sandboxOpId: sandbox.appId, changedFunctions: controller.changedFunctions,
      });
    } catch (error) {
      const reason = error instanceof ConvexError ? String(error.data) : "reserve_failed";
      return { status: "rejected", reason };
    }
    const outcome = await ctx.runAction(internal.execution.runCase, {
      sandboxOpId: sandbox.appId, investigationId: args.investigationId, attemptId: args.attemptId, experimentId,
      simCase, controllerSource: controller.source, timeoutSec: 30,
    });
    let committed = false;
    try {
      for (const [artifactId, kind] of [[outcome.traceArtifactId, "trace"], [outcome.replayArtifactId, "replay"]] as const) {
        if (!artifactId) continue;
        const artifact = await ctx.runQuery(internal.artifacts.getByAppId, { artifactId });
        if (artifact) {
          await ctx.runAction(internal.bridge.recordArtifact, {
            grant: grantRef(args), id: artifactId, kind, sha256: artifact.sha256, bytes: artifact.bytes,
            storage: "convex", storageKey: `inv/${args.investigationId}/${artifact.storageKey}`,
          });
        }
      }
      const result = await ctx.runAction(internal.bridge.recordExperiment, {
        grant: grantRef(args), id: experimentId, investigationId: args.investigationId, environmentId: args.environmentId,
        simCase, status: outcome.status, failureKinds: outcome.failureKinds, completed: outcome.completed,
        ...(outcome.completionTimeSec !== undefined ? { completionTimeSec: outcome.completionTimeSec } : {}),
        changedFunctions: controller.changedFunctions, ...(outcome.traceArtifactId ? { traceArtifactId: outcome.traceArtifactId } : {}),
        ...(outcome.replayArtifactId ? { replayArtifactId: outcome.replayArtifactId } : {}), engineVersion: outcome.engineVersion,
        assetsSha256: outcome.assetsSha256, controllerSha256: outcome.controllerSha256, startedAtMs: Date.now() - outcome.wallMs, finishedAtMs: Date.now(),
      });
      committed = result.committed;
    } catch {
      committed = false;
    }
    await ctx.runMutation(internal.evidence.finishExperiment, {
      experimentId, status: outcome.status, failureKinds: outcome.failureKinds, completed: outcome.completed,
      ...(outcome.completionTimeSec !== undefined ? { completionTimeSec: outcome.completionTimeSec } : {}),
      ...(outcome.firstFailure ? { firstFailure: outcome.firstFailure } : {}), engineVersion: outcome.engineVersion,
      assetsSha256: outcome.assetsSha256, controllerSha256: outcome.controllerSha256,
      ...(outcome.traceArtifactId ? { traceArtifactId: outcome.traceArtifactId } : {}),
      ...(outcome.replayArtifactId ? { replayArtifactId: outcome.replayArtifactId } : {}), spacetimeCommitted: committed,
    });
    await commitFindingUses(ctx, args, citedFindings, { experimentId });
    return {
      mode: "live", experimentId, caseId: simCase.caseId, seed: simCase.seed, revisionId: controller.revisionId ?? null,
      controllerSha256: outcome.controllerSha256, status: outcome.status, completed: outcome.completed,
      completionTimeSec: outcome.completionTimeSec ?? null, failureKinds: outcome.failureKinds, firstFailure: outcome.firstFailure ?? null,
      replayArtifactId: outcome.replayArtifactId ?? null, wallMs: outcome.wallMs, sharedToSpacetime: committed,
      stderrTail: outcome.exitCode === 0 ? undefined : outcome.logTail.slice(-600),
    };
  },
});

/** Approved patch mechanism: the agent proposes the complete controller
 *  source; Convex hashes it, stores the immutable artifact, and commits a
 *  revision under a SpacetimeDB revision lease with an expected-head check. */
export const proposeRevision = internalAction({
  args: {
    ...toolContext, source: v.string(), rationale: v.string(), expectedHeadRevisionId: v.optional(v.union(v.string(), v.null())),
    basedOnFindings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    await authorize(ctx, args);
    const revisionCitations = await validateBasedOnFindings(ctx, args, args.basedOnFindings ?? []);
    if (revisionCitations.status === "rejected") return revisionCitations;
    const bytes = new TextEncoder().encode(args.source);
    if (!bytes.byteLength || bytes.byteLength > 200_000) return { status: "rejected", reason: "source_size_invalid" };
    if (!/^\s*def\s+plan\s*\(/m.test(args.source)) return { status: "rejected", reason: "plan_function_required", detail: "controller must define plan(scene)" };
    if (/\b(import\s+(os|sys|subprocess|socket|shutil|pathlib)|__import__|open\s*\()/m.test(args.source)) {
      return { status: "rejected", reason: "disallowed_import", detail: "controllers may not touch the filesystem, processes or network" };
    }
    const sha = await sha256Hex(bytes);
    const baseline = await baselineSource(ctx);
    const changed = changedFunctions(baseline.source, args.source);
    const head = await ctx.runQuery(internal.evidence.environmentHead, { environmentId: args.environmentId });
    if (args.expectedHeadRevisionId !== undefined && args.expectedHeadRevisionId !== (head?.appId ?? null)) {
      return { status: "rejected", reason: "stale_head" };
    }
    if (head?.controllerSha256 === sha) return { status: "unchanged", revisionId: head.appId, controllerSha256: sha, changedFunctions: changed };
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/json" }));
    const artifact = await ctx.runMutation(internal.artifacts.insertCloudArtifact, {
      kind: "controller_source", sha256: sha, bytes: bytes.byteLength, investigationId: args.investigationId,
      attemptId: args.attemptId, visibility: "internal", storageId,
    });
    const revisionId = appId();
    try {
      await ctx.runMutation(internal.evidence.commitRevision, {
        revisionId, investigationId: args.investigationId, environmentId: args.environmentId, attemptId: args.attemptId,
        epoch: args.epoch, grantId: args.grantId, controllerSha256: sha, sourceArtifactId: artifact.artifactId, source: args.source,
        changedFunctions: changed, rationale: args.rationale.slice(0, 4000), ...(head ? { expectedHeadRevisionId: head.appId } : {}),
        ...(args.basedOnFindings?.length ? { basedOnFindings: args.basedOnFindings } : {}),
      });
    } catch (error) {
      return { status: "rejected", reason: error instanceof ConvexError ? String(error.data) : "commit_failed" };
    }
    let committed = false;
    try {
      await ctx.runAction(internal.bridge.recordArtifact, {
        grant: grantRef(args), id: artifact.artifactId, kind: "controller_source", sha256: sha, bytes: bytes.byteLength,
        storage: "convex", storageKey: `inv/${args.investigationId}/${String(storageId)}`,
      });
      const result = await ctx.runAction(internal.bridge.commitRevision, {
        grant: grantRef(args), environmentId: args.environmentId, revisionId, ...(head ? { expectedHeadRevisionId: head.appId } : {}),
        controllerSha256: sha, sourceArtifactId: artifact.artifactId, changedFunctions: changed,
      });
      committed = result.committed;
    } catch {
      committed = false;
    }
    await ctx.runMutation(internal.evidence.markCommitted, { table: "controllerRevisions", appId: revisionId, committed });
    return { status: "committed", revisionId, controllerSha256: sha, changedFunctions: changed, parentRevisionId: head?.appId ?? null, sharedToSpacetime: committed };
  },
});

export const applyPatch = internalAction({
  args: {
    ...toolContext, diff: v.string(), expectedHeadRevisionId: v.union(v.string(), v.null()), rationale: v.string(),
    basedOnFindings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    await authorize(ctx, args);
    const citations = await validateBasedOnFindings(ctx, args, args.basedOnFindings ?? []);
    if (citations.status === "rejected") return citations;
    const head = await ctx.runQuery(internal.evidence.environmentHead, { environmentId: args.environmentId });
    if ((head?.appId ?? null) !== args.expectedHeadRevisionId) return { status: "rejected", reason: "stale_head" };
    const current = await resolveController(ctx, args, head?.appId);
    let source: string;
    try {
      source = applyUnifiedDiff(current.source, args.diff);
    } catch (error) {
      return { status: "rejected", reason: error instanceof ConvexError ? String(error.data) : "patch_invalid" };
    }
    return await ctx.runAction(internal.agentTools.proposeRevision, {
      credentialId: args.credentialId, investigationId: args.investigationId, environmentId: args.environmentId,
      sessionId: args.sessionId, attemptId: args.attemptId, grantId: args.grantId, epoch: args.epoch,
      source, rationale: args.rationale, expectedHeadRevisionId: args.expectedHeadRevisionId,
      ...(args.basedOnFindings?.length ? { basedOnFindings: args.basedOnFindings } : {}),
    });
  },
});

export const forkCandidate = internalAction({
  args: { ...toolContext, candidateId: v.string(), rationale: v.string(), basedOnFindings: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    await authorize(ctx, args);
    const citations = await validateBasedOnFindings(ctx, args, args.basedOnFindings ?? []);
    if (citations.status === "rejected") return citations;
    const citedFindings = citations.findings;
    const candidate = await ctx.runQuery(internal.agentTools.getCandidateForFork, {
      candidateId: args.candidateId, investigationId: args.investigationId,
    });
    if (!candidate || candidate.investigationId !== args.investigationId) return { status: "rejected", reason: "candidate_not_found" };
    if (!candidate.revisionId) return { status: "rejected", reason: "revision_not_found" };
    const revision = await ctx.runQuery(internal.evidence.getRevision, { revisionId: candidate.revisionId });
    if (!revision?.source) return { status: "rejected", reason: "revision_not_found" };
    const fork = await ctx.runAction(internal.agentTools.proposeRevision, {
      credentialId: args.credentialId, investigationId: args.investigationId, environmentId: args.environmentId,
      sessionId: args.sessionId, attemptId: args.attemptId, grantId: args.grantId, epoch: args.epoch,
      source: revision.source, rationale: args.rationale,
    }) as Record<string, unknown>;
    if (fork.status !== "committed" || typeof fork.revisionId !== "string") return fork;
    const submitted = await ctx.runAction(internal.agentTools.submitCandidate, {
      credentialId: args.credentialId, investigationId: args.investigationId, environmentId: args.environmentId,
      sessionId: args.sessionId, attemptId: args.attemptId, grantId: args.grantId, epoch: args.epoch,
      revisionId: fork.revisionId, rationale: args.rationale, basedOnFindings: args.basedOnFindings ?? [],
    });
    if ((submitted as any).candidateId) {
      await commitFindingUses(ctx, args, citedFindings, { candidateId: (submitted as any).candidateId });
    }
    return { ...fork, candidate: submitted };
  },
});

export const FINDING_REQUIRED_DETAIL =
  "Record at least one finding for this environment with write_finding (cite the experimentId you measured) before submit_candidate.";

export const candidatePreconditions = internalQuery({
  args: { investigationId: v.string(), environmentId: v.string(), revisionId: v.string() },
  handler: async (ctx, args): Promise<{ environmentFindings: number; revisionFindings: string[] }> => {
    const findings = await ctx.db.query("findings").withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId)).collect();
    const revision = await ctx.db.query("controllerRevisions").withIndex("by_appId", (q) => q.eq("appId", args.revisionId)).unique();
    return {
      environmentFindings: findings.filter((row) => row.investigationId === args.investigationId).length,
      revisionFindings: revision?.environmentId === args.environmentId ? revision.basedOnFindings ?? [] : [],
    };
  },
});

export const submitCandidate = internalAction({
  args: { ...toolContext, revisionId: v.string(), rationale: v.string(), basedOnFindings: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    await authorize(ctx, args);
    const preconditions = await ctx.runQuery(internal.agentTools.candidatePreconditions, {
      investigationId: args.investigationId, environmentId: args.environmentId, revisionId: args.revisionId,
    });
    if (preconditions.environmentFindings < 1) {
      return { status: "rejected", reason: "finding_required", detail: FINDING_REQUIRED_DETAIL };
    }
    const basedOnFindings = [...new Set([...args.basedOnFindings, ...preconditions.revisionFindings])];
    const citations = await validateBasedOnFindings(ctx, args, basedOnFindings);
    if (citations.status === "rejected") return citations;
    const citedFindings = citations.findings;
    const candidateId = appId();
    let inserted;
    try {
      inserted = await ctx.runMutation(internal.evidence.insertCandidate, {
        candidateId, investigationId: args.investigationId, environmentId: args.environmentId, revisionId: args.revisionId,
        attemptId: args.attemptId, epoch: args.epoch, grantId: args.grantId, rationale: args.rationale.slice(0, 4000), basedOnFindings,
      });
    } catch (error) {
      return { status: "rejected", reason: error instanceof ConvexError ? String(error.data) : "submit_failed" };
    }
    const candidate = inserted.candidate;
    let committed = false;
    try {
      const result = await ctx.runAction(internal.bridge.submitCandidate, {
        grant: grantRef(args), id: candidateId, investigationId: args.investigationId, environmentId: args.environmentId,
        revisionId: args.revisionId, controllerSha256: candidate.controllerSha256, sourceArtifactId: candidate.sourceArtifactId,
        changedFunctions: candidate.changedFunctions, rationale: args.rationale.slice(0, 4000), basedOnFindings,
      });
      committed = result.committed;
    } catch {
      committed = false;
    }
    await ctx.runMutation(internal.evidence.markCommitted, { table: "candidates", appId: candidateId, committed });
    await commitFindingUses(ctx, args, citedFindings, { candidateId });
    return { status: "submitted", candidateId, controllerSha256: candidate.controllerSha256, changedFunctions: candidate.changedFunctions, sharedToSpacetime: committed };
  },
});

export const writeFinding = internalAction({
  args: {
    ...toolContext,
    kind: v.union(v.literal("collision_frame"), v.literal("limit_violation"), v.literal("behavioral_note"), v.literal("candidate_hypothesis"), v.literal("cross_environment_pattern")),
    claim: v.optional(v.union(v.literal("observation"), v.literal("inference"))),
    summary: v.string(),
    evidence: v.array(v.object({
      kind: v.union(v.literal("trace_frame"), v.literal("contact_event"), v.literal("metric"), v.literal("log_excerpt"), v.literal("code_diff"), v.literal("replay_segment")),
      artifactId: v.optional(v.string()), experimentId: v.optional(v.string()), locator: v.any(), excerpt: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    await authorize(ctx, args);
    if (!args.evidence.length) return { status: "rejected", reason: "evidence_required", detail: "cite at least one experiment or artifact" };
    const findingId = appId();
    const claim = args.claim ?? (args.evidence.some((item) => item.experimentId || item.artifactId) ? "observation" : "inference");
    try {
      await ctx.runMutation(internal.evidence.insertFinding, {
        findingId, investigationId: args.investigationId, environmentId: args.environmentId, sessionId: args.sessionId,
        attemptId: args.attemptId, epoch: args.epoch, grantId: args.grantId, kind: args.kind, claim, summary: args.summary.slice(0, 2000),
        evidence: args.evidence.map((item) => ({ ...item, locator: item.locator ?? {} })),
      });
    } catch (error) {
      return { status: "rejected", reason: error instanceof ConvexError ? String(error.data) : "finding_rejected" };
    }
    let committed = false;
    try {
      const result = await ctx.runAction(internal.bridge.recordFinding, {
        grant: grantRef(args), id: findingId, investigationId: args.investigationId, environmentId: args.environmentId,
        sessionId: args.sessionId, kind: args.kind, claim, summary: args.summary.slice(0, 2000),
        evidence: args.evidence.map((item) => ({ ...item, locator: item.locator ?? {} })),
      });
      committed = result.committed;
    } catch {
      committed = false;
    }
    await ctx.runMutation(internal.evidence.markCommitted, { table: "findings", appId: findingId, committed });
    return { status: "recorded", findingId, claim, sharedToSpacetime: committed };
  },
});
