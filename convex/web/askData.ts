import { v } from "convex/values";
import { internalQuery } from "../_generated/server.js";

const sha64 = (value: string) => /^[0-9a-f]{64}$/i.test(value) ? value : "0".repeat(64);
const TABLES = ["environments", "findings", "experiments", "candidates", "sessions"] as const;

/** Which of `ids` belong to the investigation (ids the question mentions). */
export const scope = internalQuery({
  args: { investigationId: v.string(), ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const inv = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique();
    if (!inv) return { exists: false, foreign: args.ids };
    const foreign: string[] = [];
    for (const id of args.ids.slice(0, 10)) {
      let own = false;
      for (const table of TABLES) {
        const row = await ctx.db.query(table).withIndex("by_appId", (q) => q.eq("appId", id)).unique();
        if (row && row.investigationId === args.investigationId) { own = true; break; }
      }
      if (!own) foreign.push(id);
    }
    return { exists: true, foreign };
  },
});

/** Canonical contract records for citation validation. Withheld-suite
 *  experiments are never authorized; evidence whose artifacts were revoked is
 *  reported revoked. */
export const canonical = internalQuery({
  args: { investigationId: v.string(), findingIds: v.array(v.string()), experimentIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const revoked = async (artifactId?: string) => {
      if (!artifactId) return false;
      const a = await ctx.db.query("artifacts").withIndex("by_appId", (q) => q.eq("appId", artifactId)).unique();
      return !!a?.revokedAtMs;
    };
    const findings = [];
    for (const id of args.findingIds.slice(0, 50)) {
      const row = await ctx.db.query("findings").withIndex("by_appId", (q) => q.eq("appId", id)).unique();
      if (!row) continue;
      const evidenceRevoked = await Promise.all(row.evidence.map((e) => revoked(e.artifactId)));
      findings.push({
        authorized: row.investigationId === args.investigationId,
        evidenceRevoked,
        record: {
          id: row.appId, investigationId: row.investigationId, environmentId: row.environmentId,
          ...(row.sessionId ? { sessionId: row.sessionId } : {}), kind: row.kind, summary: row.summary,
          evidence: row.evidence.map((item) => ({
            kind: item.kind, ...(item.artifactId ? { artifactId: item.artifactId } : {}),
            ...(item.experimentId ? { experimentId: item.experimentId } : {}), locator: item.locator ?? {},
            ...(item.excerpt ? { excerpt: item.excerpt } : {}),
          })),
          createdAtMs: row.createdAtMs,
        },
      });
    }
    const experiments = [];
    for (const id of args.experimentIds.slice(0, 50)) {
      const row = await ctx.db.query("experiments").withIndex("by_appId", (q) => q.eq("appId", id)).unique();
      if (!row) continue;
      experiments.push({
        authorized: row.investigationId === args.investigationId && row.suite !== "withheld",
        revoked: (await revoked(row.replayArtifactId)) || (await revoked(row.traceArtifactId)),
        record: {
          id: row.appId, investigationId: row.investigationId, ...(row.environmentId ? { environmentId: row.environmentId } : {}),
          ...(row.candidateId ? { candidateId: row.candidateId } : {}), attemptId: row.attemptId, epoch: row.epoch, simCase: row.simCase,
          status: row.status, failureKinds: row.failureKinds, completed: row.completed,
          ...(row.completionTimeSec !== undefined ? { completionTimeSec: row.completionTimeSec } : {}), changedFunctions: row.changedFunctions,
          ...(row.traceArtifactId ? { traceArtifactId: row.traceArtifactId } : {}), ...(row.replayArtifactId ? { replayArtifactId: row.replayArtifactId } : {}),
          engineVersion: row.engineVersion, assetsSha256: sha64(row.assetsSha256), controllerSha256: sha64(row.controllerSha256),
          startedAtMs: row.startedAtMs, ...(row.finishedAtMs !== undefined ? { finishedAtMs: row.finishedAtMs } : {}),
        },
      });
    }
    return { findings, experiments };
  },
});
