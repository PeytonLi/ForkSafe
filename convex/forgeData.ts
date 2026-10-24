import { v } from "convex/values";
import { internalQuery } from "./_generated/server.js";

export const evidence = internalQuery({
  args: { investigationId: v.string() },
  handler: async (ctx, { investigationId }) => {
    const rows = (await ctx.db.query("findings").withIndex("by_investigation", (q) => q.eq("investigationId", investigationId)).collect()).sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 25);
    const artifacts = await ctx.db.query("artifacts").withIndex("by_investigation", (q) => q.eq("investigationId", investigationId)).order("desc").collect();
    const pack = artifacts.sort((a, b) => b.createdAtMs - a.createdAtMs).find((a) => a.kind === "report" && a.evidencePack === true && a.visibility !== "withheld" && a.revokedAtMs === undefined && a.storage === "convex" && a.storageId);
    const evidencePackUrl = pack?.storageId ? await ctx.storage.getUrl(pack.storageId) : null;
    return {
      findings: rows.map((row) => ({
        id: row.appId, kind: row.kind, summary: row.summary.slice(0, 500), environmentId: row.environmentId,
        citations: row.evidence.slice(0, 10).map((item) => ({ kind: item.kind, ...(item.artifactId ? { artifactId: item.artifactId } : {}), ...(item.experimentId ? { experimentId: item.experimentId } : {}) })),
      })),
      ...(evidencePackUrl?.startsWith("https://") ? { evidencePackUrl } : {}),
    };
  },
});
