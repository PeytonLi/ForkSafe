import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server.js";
import { requireUiAccess } from "./lib/auth.js";
import { unifiedDiff } from "./lib/controllerDiff.js";
import { assertUUID } from "./lib/validators.js";

/** Web: `candidates:replay` — replay of the candidate on the original failing
 *  case (evaluator run preferred, else the submitting environment's run). */
export const replay = query({
  args: { candidateId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    assertUUID(args.candidateId, "candidateId");
    const candidate = await ctx.db.query("candidates").withIndex("by_appId", (q) => q.eq("appId", args.candidateId)).unique();
    if (!candidate) throw new ConvexError("candidate not found");
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", candidate.investigationId)).unique();
    const byCandidate = await ctx.db.query("experiments").withIndex("by_candidate", (q) => q.eq("candidateId", candidate.appId)).collect();
    const byEnvironment = await ctx.db.query("experiments").withIndex("by_environment", (q) => q.eq("environmentId", candidate.environmentId)).collect();
    const pool = [...byCandidate, ...byEnvironment]
      .filter((row) => row.suite !== "withheld" && row.controllerSha256 === candidate.controllerSha256 && row.replayArtifactId);
    const preferred = pool.find((row) => row.simCase.caseId === investigation?.baselineCase.caseId && row.purpose === "evaluation")
      ?? pool.find((row) => row.simCase.caseId === investigation?.baselineCase.caseId)
      ?? pool.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    if (!preferred?.replayArtifactId) throw new ConvexError("replay not found for candidate");
    const replayRow = await ctx.db.query("replays").withIndex("by_artifact", (q) => q.eq("artifactId", preferred.replayArtifactId!)).unique();
    if (!replayRow || replayRow.visibility === "withheld") throw new ConvexError("replay not found for candidate");
    return replayRow.result;
  },
});

/** Web: `candidates:diff` — unified diff against the baseline controller. */
export const diff = query({
  args: { candidateId: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    assertUUID(args.candidateId, "candidateId");
    const candidate = await ctx.db.query("candidates").withIndex("by_appId", (q) => q.eq("appId", args.candidateId)).unique();
    if (!candidate) throw new ConvexError("candidate not found");
    const baseline = await ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", "baseline_controller")).unique();
    const baselineSource = baseline ? await ctx.db.query("controllerSources").withIndex("by_sha", (q) => q.eq("controllerSha256", baseline.sha256)).unique() : null;
    const candidateSource = await ctx.db.query("controllerSources").withIndex("by_sha", (q) => q.eq("controllerSha256", candidate.controllerSha256)).unique();
    if (!candidateSource) throw new ConvexError("candidate source not found");
    return unifiedDiff(baselineSource?.source ?? "", candidateSource.source);
  },
});
