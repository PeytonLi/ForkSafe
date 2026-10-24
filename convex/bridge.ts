import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import {
  SpacetimeReducerError,
  classifyReducerFailure,
  decodeSqlRows,
  encodeReducerArgs,
  option,
  spacetimeConfig,
  sqlLiteral,
  type SpacetimeMode,
} from "./lib/spacetime.js";

/** Convex is the registered SpacetimeDB bridge. Every write to the shared
 *  evidence lane goes through these actions; grants are fenced by
 *  job + attempt + epoch so stale attempts are rejected inside the module. */

type BridgeState = { token?: string; identity?: string; registeredAtMs?: number };

export const getBridgeState = internalQuery({
  args: {},
  handler: async (ctx): Promise<BridgeState> => {
    const flag = await ctx.db.query("systemFlags").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    return { token: flag?.bridgeToken, identity: flag?.bridgeIdentity, registeredAtMs: flag?.bridgeRegisteredAtMs };
  },
});

export const saveBridgeState = internalMutation({
  args: {
    token: v.optional(v.string()),
    identity: v.optional(v.string()),
    registeredAtMs: v.optional(v.number()),
    lastError: v.optional(v.string()),
    mode: v.optional(v.string()),
    healthy: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const flag = await ctx.db.query("systemFlags").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    const patch = {
      ...(args.token !== undefined ? { bridgeToken: args.token } : {}),
      ...(args.identity !== undefined ? { bridgeIdentity: args.identity } : {}),
      ...(args.registeredAtMs !== undefined ? { bridgeRegisteredAtMs: args.registeredAtMs } : {}),
      ...(args.mode !== undefined ? { bridgeMode: args.mode } : {}),
      bridgeLastError: args.lastError,
      ...(args.healthy ? { bridgeLastHealthyAtMs: Date.now() } : {}),
    };
    if (flag) await ctx.db.patch(flag._id, patch);
    else await ctx.db.insert("systemFlags", { key: "global", admissionPaused: false, ...patch });
  },
});

export const resetBridgeState = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ reset: boolean }> => {
    const flag = await ctx.db.query("systemFlags").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (!flag) return { reset: false };
    await ctx.db.patch(flag._id, {
      bridgeToken: undefined,
      bridgeIdentity: undefined,
      bridgeRegisteredAtMs: undefined,
      bridgeLastHealthyAtMs: undefined,
      bridgeLastError: "bridge_state_reset",
    });
    return { reset: true };
  },
});

type ActionCtx = { runQuery: any; runMutation: any };

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const response = await fetch(url, init);
  return { status: response.status, text: await response.text() };
}

async function obtainToken(ctx: ActionCtx, httpBase: string): Promise<{ token: string; identity: string }> {
  const envToken = process.env.SPACETIMEDB_BRIDGE_TOKEN;
  const state: BridgeState = await ctx.runQuery(internal.bridge.getBridgeState, {});
  if (envToken) return { token: envToken, identity: state.identity ?? "env" };
  if (state.token) return { token: state.token, identity: state.identity ?? "stored" };
  const created = await fetchJson(`${httpBase}/v1/identity`, { method: "POST" });
  if (created.status !== 200) throw new ConvexError("spacetime_identity_unavailable");
  const parsed = JSON.parse(created.text) as { token: string; identity: string };
  await ctx.runMutation(internal.bridge.saveBridgeState, { token: parsed.token, identity: parsed.identity });
  return parsed;
}

export class BridgeClient {
  readonly mode: SpacetimeMode;
  private readonly httpBase: string;
  private readonly database: string;
  private token?: string;
  private identity?: string;

  constructor(private readonly ctx: ActionCtx, env: Record<string, string | undefined> = process.env) {
    const config = spacetimeConfig(env);
    this.mode = config.mode;
    this.httpBase = config.httpBase;
    this.database = config.database;
  }

  get enabled(): boolean {
    return this.mode === "live" || this.mode === "local";
  }

  async register(): Promise<{ mode: SpacetimeMode; identity?: string }> {
    if (!this.enabled) return { mode: this.mode };
    const secret = process.env.FORKSAFE_BRIDGE_SECRET;
    if (!secret) throw new ConvexError("bridge_secret_missing");
    const { token, identity } = await obtainToken(this.ctx, this.httpBase);
    this.token = token;
    this.identity = identity;
    const result = await fetchJson(this.url("call/register_bridge"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    if (result.status !== 200) {
      const failure = classifyReducerFailure(result.status, result.text);
      await this.ctx.runMutation(internal.bridge.saveBridgeState, { lastError: failure.code, mode: this.mode });
      throw failure;
    }
    await this.ctx.runMutation(internal.bridge.saveBridgeState, {
      identity, registeredAtMs: Date.now(), mode: this.mode, healthy: true,
    });
    return { mode: this.mode, identity };
  }

  /** Calls a reducer; re-registers once if the bridge identity was lost. */
  async call(reducer: string, args: Record<string, unknown>): Promise<{ committed: boolean; mode: SpacetimeMode }> {
    if (!this.enabled) return { committed: false, mode: this.mode };
    if (!this.token) {
      const { token, identity } = await obtainToken(this.ctx, this.httpBase);
      this.token = token;
      this.identity = identity;
    }
    const body = JSON.stringify(encodeReducerArgs(args));
    let result = await this.post(reducer, body);
    if (result.status !== 200 && /^\s*bridge_required/.test(result.text)) {
      await this.register();
      result = await this.post(reducer, body);
    }
    if (result.status !== 200) throw classifyReducerFailure(result.status, result.text);
    return { committed: true, mode: this.mode };
  }

  async sql(query: string): Promise<Record<string, unknown>[]> {
    if (!this.enabled) return [];
    if (!this.token) this.token = (await obtainToken(this.ctx, this.httpBase)).token;
    const result = await fetchJson(this.url("sql"), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "text/plain" },
      body: query,
    });
    if (result.status !== 200) throw classifyReducerFailure(result.status, result.text);
    return decodeSqlRows(JSON.parse(result.text));
  }

  private post(reducer: string, body: string) {
    return fetchJson(this.url(`call/${reducer}`), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body,
    });
  }

  private url(path: string): string {
    return `${this.httpBase}/v1/database/${encodeURIComponent(this.database)}/${path}`;
  }
}

export const register = internalAction({
  args: {},
  handler: async (ctx): Promise<{ mode: SpacetimeMode; identity?: string }> => {
    const client = new BridgeClient(ctx);
    return await client.register();
  },
});

const grantArgs = {
  grantId: v.string(),
  jobId: v.string(),
  attemptId: v.string(),
  epoch: v.number(),
  investigationId: v.string(),
  environmentId: v.optional(v.string()),
  operations: v.array(v.string()),
  artifactPrefixes: v.array(v.string()),
  maxBytes: v.number(),
  expiresAtMs: v.number(),
};

/** Installs the grant in SpacetimeDB (idempotent on identical fields) and
 *  records the outcome on the Convex grant row. */
export const installGrant = internalAction({
  args: grantArgs,
  handler: async (ctx, args): Promise<{ committed: boolean; mode: SpacetimeMode; error?: string }> => {
    const client = new BridgeClient(ctx);
    try {
      const result = await client.call("install_grant", {
        id: args.grantId,
        jobId: args.jobId,
        attemptId: args.attemptId,
        epoch: args.epoch,
        investigationId: args.investigationId,
        environmentId: option(args.environmentId),
        operations: args.operations,
        artifactPrefixes: args.artifactPrefixes,
        maxBytes: args.maxBytes,
        expiresAtMs: args.expiresAtMs,
      });
      await ctx.runMutation(internal.grants.markInstalled, { grantId: args.grantId, committed: result.committed, mode: result.mode });
      return result;
    } catch (error) {
      const code = error instanceof SpacetimeReducerError ? error.code : "bridge_unreachable";
      await ctx.runMutation(internal.grants.markInstalled, { grantId: args.grantId, committed: false, mode: client.mode, error: code });
      return { committed: false, mode: client.mode, error: code };
    }
  },
});

export const revokeGrant = internalAction({
  args: { grantId: v.string(), reason: v.string() },
  handler: async (ctx, args): Promise<{ revoked: boolean; mode: SpacetimeMode; error?: string }> => {
    const client = new BridgeClient(ctx);
    try {
      const result = await client.call("revoke_grant", { grantId: args.grantId, reason: args.reason });
      await ctx.runMutation(internal.grants.markRevoked, { grantId: args.grantId, spacetimeRevoked: result.committed || !client.enabled, reason: args.reason });
      return { revoked: true, mode: result.mode };
    } catch (error) {
      const code = error instanceof SpacetimeReducerError ? error.code : "bridge_unreachable";
      await ctx.runMutation(internal.grants.markRevoked, { grantId: args.grantId, spacetimeRevoked: false, reason: args.reason, error: code });
      return { revoked: false, mode: client.mode, error: code };
    }
  },
});

const grantRef = v.object({ grantId: v.string(), attemptId: v.string(), epoch: v.number() });

export const recordArtifact = internalAction({
  args: {
    grant: grantRef, id: v.string(), kind: v.string(), sha256: v.string(), bytes: v.number(),
    storage: v.string(), storageKey: v.string(),
  },
  handler: async (ctx, args) => {
    const client = new BridgeClient(ctx);
    return await client.call("record_artifact", args);
  },
});

export const recordExperiment = internalAction({
  args: {
    grant: grantRef,
    id: v.string(),
    investigationId: v.string(),
    environmentId: v.optional(v.string()),
    candidateId: v.optional(v.string()),
    simCase: v.object({
      caseId: v.string(), suite: v.string(), seed: v.number(),
      sceneOverrides: v.record(v.string(), v.number()), description: v.optional(v.string()),
    }),
    status: v.string(),
    failureKinds: v.array(v.string()),
    completed: v.boolean(),
    completionTimeSec: v.optional(v.number()),
    changedFunctions: v.array(v.string()),
    traceArtifactId: v.optional(v.string()),
    replayArtifactId: v.optional(v.string()),
    engineVersion: v.string(),
    assetsSha256: v.string(),
    controllerSha256: v.string(),
    startedAtMs: v.number(),
    finishedAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const client = new BridgeClient(ctx);
    return await client.call("record_experiment", {
      ...args,
      environmentId: option(args.environmentId),
      candidateId: option(args.candidateId),
      simCase: {
        caseId: args.simCase.caseId,
        suite: args.simCase.suite,
        seed: args.simCase.seed,
        sceneOverridesJson: JSON.stringify(args.simCase.sceneOverrides),
        description: option(args.simCase.description),
      },
      completionTimeSec: option(args.completionTimeSec),
      traceArtifactId: option(args.traceArtifactId),
      replayArtifactId: option(args.replayArtifactId),
      finishedAtMs: option(args.finishedAtMs),
    });
  },
});

export const recordFinding = internalAction({
  args: {
    grant: grantRef,
    id: v.string(),
    investigationId: v.string(),
    environmentId: v.string(),
    sessionId: v.optional(v.string()),
    kind: v.string(),
    claim: v.string(),
    summary: v.string(),
    evidence: v.array(v.object({
      kind: v.string(), artifactId: v.optional(v.string()), experimentId: v.optional(v.string()),
      locator: v.any(), excerpt: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const client = new BridgeClient(ctx);
    return await client.call("record_finding", {
      ...args,
      sessionId: option(args.sessionId),
      evidence: args.evidence.map((item) => ({
        kind: item.kind,
        artifactId: option(item.artifactId),
        experimentId: option(item.experimentId),
        locatorJson: JSON.stringify(item.locator ?? {}),
        excerpt: option(item.excerpt),
      })),
      links: [],
    });
  },
});

/** Revision commits need a live revision lease held by the same attempt. */
export const commitRevision = internalAction({
  args: {
    grant: grantRef,
    environmentId: v.string(),
    revisionId: v.string(),
    expectedHeadRevisionId: v.optional(v.string()),
    controllerSha256: v.string(),
    sourceArtifactId: v.string(),
    changedFunctions: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ committed: boolean; mode: SpacetimeMode }> => {
    const client = new BridgeClient(ctx);
    if (!client.enabled) return { committed: false, mode: client.mode };
    await client.call("acquire_revision_lease", { grant: args.grant, environmentId: args.environmentId });
    try {
      return await client.call("commit_revision", {
        grant: args.grant,
        environmentId: args.environmentId,
        revisionId: args.revisionId,
        expectedHeadRevisionId: option(args.expectedHeadRevisionId),
        forkedFromRevisionId: null,
        controllerSha256: args.controllerSha256,
        sourceArtifactId: args.sourceArtifactId,
        changedFunctions: args.changedFunctions,
      });
    } finally {
      await client.call("release_revision_lease", { grant: args.grant, environmentId: args.environmentId }).catch(() => undefined);
    }
  },
});

export const submitCandidate = internalAction({
  args: {
    grant: grantRef,
    id: v.string(),
    investigationId: v.string(),
    environmentId: v.string(),
    revisionId: v.optional(v.string()),
    controllerSha256: v.string(),
    sourceArtifactId: v.string(),
    changedFunctions: v.array(v.string()),
    rationale: v.optional(v.string()),
    basedOnFindings: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const client = new BridgeClient(ctx);
    return await client.call("submit_candidate", {
      ...args,
      revisionId: option(args.revisionId),
      rationale: option(args.rationale),
    });
  },
});

export const recordFindingUse = internalAction({
  args: {
    grant: grantRef,
    id: v.string(),
    findingId: v.string(),
    experimentId: v.optional(v.string()),
    candidateId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if ((args.experimentId === undefined) === (args.candidateId === undefined)) {
      throw new ConvexError("finding_use_target_invalid");
    }
    const client = new BridgeClient(ctx);
    return await client.call("record_finding_use", {
      grant: args.grant, id: args.id, findingId: args.findingId,
      experimentId: option(args.experimentId), candidateId: option(args.candidateId),
    });
  },
});

export const recordEvaluation = internalAction({
  args: {
    grant: grantRef,
    id: v.string(),
    candidateId: v.string(),
    investigationId: v.string(),
    suite: v.string(),
    cases: v.array(v.object({
      caseId: v.string(), status: v.string(), experimentId: v.optional(v.string()),
      completionTimeSec: v.optional(v.number()), failureKinds: v.array(v.string()),
    })),
    allRequiredPassed: v.boolean(),
    medianCompletionTimeSec: v.optional(v.number()),
    status: v.string(),
    reportArtifactId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const client = new BridgeClient(ctx);
    return await client.call("record_evaluation", {
      ...args,
      cases: args.cases.map((item) => ({
        caseId: item.caseId,
        status: item.status,
        experimentId: option(item.experimentId),
        completionTimeSec: option(item.completionTimeSec),
        failureKinds: item.failureKinds,
      })),
      medianCompletionTimeSec: option(args.medianCompletionTimeSec),
      reportArtifactId: option(args.reportArtifactId),
    });
  },
});

export const recordReview = internalAction({
  args: {
    id: v.string(),
    investigationId: v.string(),
    candidateId: v.string(),
    evaluationId: v.string(),
    controllerSha256: v.string(),
    decision: v.string(),
    reviewerIdentity: v.string(),
    notes: v.optional(v.string()),
    jiraIssueKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const client = new BridgeClient(ctx);
    return await client.call("record_review", {
      ...args,
      notes: option(args.notes),
      jiraIssueKey: option(args.jiraIssueKey),
    });
  },
});

/** Row counts per table for one investigation (reporting only). */
export const countRows = internalAction({
  args: { investigationId: v.string() },
  handler: async (ctx, args): Promise<{ mode: SpacetimeMode; counts: Record<string, number> }> => {
    const client = new BridgeClient(ctx);
    if (!client.enabled) return { mode: client.mode, counts: {} };
    const id = sqlLiteral(args.investigationId);
    const counts: Record<string, number> = {};
    for (const table of ["experiment", "finding", "candidate", "evaluation", "human_review", "execution_grant"]) {
      const rows = await client.sql(`SELECT * FROM ${table} WHERE investigation_id = ${id}`);
      counts[table] = rows.length;
    }
    const revisions = await client.sql("SELECT * FROM controller_revision");
    counts.controller_revision = revisions.length;
    return { mode: client.mode, counts };
  },
});
