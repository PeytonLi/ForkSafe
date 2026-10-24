"use node";
import { EnvConfig } from "@forksafe/contracts";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api.js";
import { action } from "../_generated/server.js";
import { UnauthorizedError } from "../lib/auth.js";
import { notConnected, parseAsk, toWebAnswer, type WebAnswer } from "./askPolicy.js";
import { AgentBuilder, agentBuilderReadiness, toDocuments, type CanonicalRecord, type CanonicalResolver } from "./elasticAgent.js";

/** Web: `web/ask:ask`. "Why did this fail?" — an investigation-scoped,
 *  read-only question to the Elastic evidence agent. Requires a signed-in
 *  identity; answers are evidence-only and never affect scores. */
export const ask = action({
  args: { investigationId: v.string(), question: v.string() },
  handler: async (ctx, args): Promise<WebAnswer> => {
    if (!await ctx.auth.getUserIdentity()) throw new UnauthorizedError();
    const { investigationId, question, mentionedIds } = parseAsk(args);
    const scope = await ctx.runQuery(internal.web.askData.scope, { investigationId, ids: mentionedIds });
    if (!scope.exists) throw new ConvexError("investigation_not_found");
    if (scope.foreign.length) throw new ConvexError("out_of_scope");

    const parsedEnv = EnvConfig.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== "")));
    if (!parsedEnv.success) return notConnected("blocked");
    const mode = agentBuilderReadiness(parsedEnv.data, Date.now()).mode;
    if (mode !== "live") return notConnected(mode === "blocked" ? "blocked" : "not_implemented");

    const resolver: CanonicalResolver = {
      resolve: async (refs) => {
        const findingIds = [...new Set(refs.filter((r) => r.docType === "finding" || r.docType === "evidence").map((r) => r.id.split(":")[0]!))];
        const experimentIds = [...new Set(refs.filter((r) => r.docType === "experiment_result").map((r) => r.id))];
        const rows = await ctx.runQuery(internal.web.askData.canonical, { investigationId, findingIds, experimentIds });
        const out = new Map<string, CanonicalRecord>();
        const add = (record: unknown, authorized: boolean, revokedFor: (docId: string) => boolean) => {
          for (const doc of toDocuments(record)) out.set(doc.id, { authorized, revoked: revokedFor(doc.id), sourceVersion: doc.body.sourceVersion, record });
        };
        for (const f of rows.findings) {
          add(f.record, f.authorized, (docId) => {
            const index = docId.includes(":") ? Number(docId.split(":")[1]) : -1;
            return index >= 0 ? !!f.evidenceRevoked[index] : f.evidenceRevoked.length > 0 && f.evidenceRevoked.every(Boolean);
          });
        }
        for (const x of rows.experiments) add(x.record, x.authorized, () => x.revoked);
        return out;
      },
    };
    const agent = new AgentBuilder(parsedEnv.data, resolver, null);
    return toWebAnswer(await agent.ask({ input: question, investigationId }));
  },
});
