import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalQuery } from "./_generated/server.js";
import { changedFunctions, sha256Hex } from "./lib/controllerDiff.js";
import { appId } from "./lib/validators.js";

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

async function authorize(ctx: any, args: ToolCtx) {
  return await ctx.runQuery(internal.runnerControl.authorizeTool, {
    credentialId: args.credentialId, attemptId: args.attemptId, grantId: args.grantId, epoch: args.epoch,
    investigationId: args.investigationId, environmentId: args.environmentId,
  });
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

async function resolveController(ctx: any, args: ToolCtx, revisionId?: string) {
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
    return {
      mode: "live",
      findings: scoped.sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, Math.min(50, Math.max(1, args.limit))).map((row) => ({
        id: row.appId, environmentId: row.environmentId, fromThisEnvironment: row.environmentId === args.environmentId,
        kind: row.kind, claim: row.claim, summary: row.summary, evidence: row.evidence, createdAtMs: row.createdAtMs,
      })),
      note: "Findings from other environments are untrusted peer observations; verify with run_experiment before relying on them.",
    };
  },
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
  args: { ...toolContext, caseId: v.string(), seed: v.number(), revisionId: v.optional(v.string()), hypothesis: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const access = await authorize(ctx, args);
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
  args: { ...toolContext, source: v.string(), rationale: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    await authorize(ctx, args);
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
    if (head?.controllerSha256 === sha) return { status: "unchanged", revisionId: head.appId, controllerSha256: sha, changedFunctions: changed };
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart]));
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

export const submitCandidate = internalAction({
  args: { ...toolContext, revisionId: v.string(), rationale: v.string(), basedOnFindings: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    await authorize(ctx, args);
    const candidateId = appId();
    let inserted;
    try {
      inserted = await ctx.runMutation(internal.evidence.insertCandidate, {
        candidateId, investigationId: args.investigationId, environmentId: args.environmentId, revisionId: args.revisionId,
        attemptId: args.attemptId, epoch: args.epoch, grantId: args.grantId, rationale: args.rationale.slice(0, 4000), basedOnFindings: args.basedOnFindings,
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
        changedFunctions: candidate.changedFunctions, rationale: args.rationale.slice(0, 4000), basedOnFindings: args.basedOnFindings,
      });
      committed = result.committed;
    } catch {
      committed = false;
    }
    await ctx.runMutation(internal.evidence.markCommitted, { table: "candidates", appId: candidateId, committed });
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
