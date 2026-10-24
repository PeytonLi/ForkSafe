import { z } from "zod";
import type { EnvConfig } from "@forksafe/contracts";
import { agentBuilderReadiness, resolveConfig } from "./config.ts";
import { resolveEvidence, type CanonicalResolver, type Dropped, type ElasticSearch } from "./search.ts";

const citationSchema = z.object({
  docType: z.enum(["finding", "evidence", "experiment_result"]), id: z.string().min(1),
  investigationId: z.string().min(1), sourceVersion: z.string().min(1),
});
function extractCitations(value: unknown): z.infer<typeof citationSchema>[] {
  const ref = citationSchema.safeParse(value);
  if (ref.success) return [ref.data];
  if (Array.isArray(value)) return value.flatMap(extractCitations);
  if (typeof value === "string") {
    try { return extractCitations(JSON.parse(value)); } catch { return []; }
  }
  if (value && typeof value === "object") return Object.values(value).flatMap(extractCitations);
  return [];
}
export interface AgentQuestion { input: string; investigationId: string; agentId?: string; conversationId?: string }
export interface AgentAnswer {
  mode: "live" | "fixture" | "not_implemented" | "blocked"; answer?: string; label?: string; reason?: string;
  citations?: { id: string; docType: string; canonical: unknown }[]; droppedCitations?: Dropped[];
  conversationId?: string; usage: "evidence_only"; scoreAffecting: false;
}
export class AgentBuilder {
  private env: EnvConfig;
  constructor(env: EnvConfig, private resolver: CanonicalResolver, private search: ElasticSearch, private fetcher: typeof fetch = fetch) {
    this.env = resolveConfig(env);
  }
  async ask(question: AgentQuestion): Promise<AgentAnswer> {
    if (!question.investigationId.trim()) throw new Error("investigationId is required");
    const common = { usage: "evidence_only" as const, scoreAffecting: false as const };
    const mode = agentBuilderReadiness(this.env, 0).mode;
    if (mode === "blocked") return { ...common, mode, reason: "Agent Builder credentials unavailable" };
    if (mode !== "live") {
      const result = await this.search.searchEvidence({ query: question.input, investigationId: question.investigationId });
      return { ...common, mode: mode === "fixture" ? "fixture" : "not_implemented",
        label: "Deterministic fallback — Agent Builder not used",
        answer: result.hits.length ? result.hits.map(h => `${h.docType} ${h.id}: ${summary(h.canonical)}`).join("\n") : "No authorized matching evidence.",
        citations: result.hits.map(h => ({ id: h.id, docType: h.docType, canonical: h.canonical })), droppedCitations: result.dropped };
    }
    try {
      // https://www.elastic.co/docs/api/doc/kibana/operation/operation-post-agent-builder-converse
      const response = await this.fetcher(`${this.env.KIBANA_URL!.replace(/\/$/, "")}/api/agent_builder/converse`, {
        method: "POST", headers: { Authorization: `ApiKey ${this.env.KIBANA_API_KEY!}`, "kbn-xsrf": "true", "Content-Type": "application/json" },
        body: JSON.stringify({ input: `Investigation: ${question.investigationId}. Use only forksafe-* evidence filtered to this investigationId. Read-only: do not mutate tools, agents, records or scores. Cite each source with docType, id, investigationId and sourceVersion.\nQuestion: ${question.input}`,
          ...(question.agentId ? { agent_id: question.agentId } : {}), ...(question.conversationId ? { conversation_id: question.conversationId } : {}) }),
      });
      if (!response.ok) return { ...common, mode: "blocked", reason: "Agent Builder request failed" };
      const data = await response.json() as { conversation_id?: string; steps?: unknown; response?: { message?: string } };
      const refs = [...new Map(extractCitations([data.response, data.steps]).map(ref => [ref.id, ref])).values()];
      const { accepted, dropped } = await resolveEvidence(refs, question.investigationId, this.resolver);
      // Never surface unvalidated generated prose; an unauthorized citation can taint the whole answer.
      const safeAnswer = dropped.length || !accepted.size ? "No fully validated answer available. Inspect authorized citations directly." : data.response?.message ?? "No answer returned.";
      return { ...common, mode: "live", answer: this.redact(safeAnswer), conversationId: data.conversation_id,
        citations: refs.flatMap(ref => accepted.has(ref.id) ? [{ id: ref.id, docType: ref.docType, canonical: accepted.get(ref.id)!.record }] : []), droppedCitations: dropped };
    } catch { return { ...common, mode: "blocked", reason: "Agent Builder request failed" }; }
  }
  private redact(value: string) {
    for (const secret of [this.env.KIBANA_API_KEY, this.env.ELASTICSEARCH_API_KEY]) if (secret) value = value.split(secret).join("[REDACTED]");
    return value;
  }
}
function summary(record: unknown): string {
  if (!record || typeof record !== "object") return "Authorized evidence";
  const value = record as { summary?: unknown; excerpt?: unknown; status?: unknown };
  return String(value.summary ?? value.excerpt ?? value.status ?? "Authorized evidence");
}
