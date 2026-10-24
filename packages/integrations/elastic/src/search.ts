import type { estypes } from "@elastic/elasticsearch";
import type { DocType, EvidenceDocument, Projection } from "./indexer.ts";
import { INDICES } from "./mappings.ts";

export interface CanonicalRef { docType: DocType; id: string; investigationId: string; sourceVersion: string }
export interface CanonicalRecord {
  authorized: boolean; revoked?: boolean; superseded?: boolean; deleted?: boolean;
  sourceVersion: string; record: unknown;
}
export interface CanonicalResolver { resolve(refs: CanonicalRef[]): Promise<Map<string, CanonicalRecord>> }
export interface SearchClient { search(request: estypes.SearchRequest): Promise<estypes.SearchResponse<EvidenceDocument>> }
export interface SearchInput {
  query: string; investigationId: string; environmentId?: string; docTypes?: DocType[];
  failureKinds?: string[]; kinds?: string[]; limit?: number;
}
export interface Dropped { id: string; reason: string }
export interface ResolvedHit {
  docType: DocType; id: string; score: number | null; highlight: Record<string, string[]>;
  canonical: unknown; mode: "fixture" | "live" | "local";
}
export interface SearchResult {
  mode: "fixture" | "live" | "local" | "blocked"; hits: ResolvedHit[]; dropped: Dropped[];
  usage: "evidence_only"; reason?: string;
}
export async function resolveEvidence(refs: CanonicalRef[], investigationId: string, resolver: CanonicalResolver) {
  const dropped: Dropped[] = [];
  const accepted = new Map<string, CanonicalRecord>();
  let records: Map<string, CanonicalRecord>;
  try { records = await resolver.resolve(refs); }
  catch { return { accepted, dropped: refs.map(ref => ({ id: ref.id, reason: "resolver_unavailable" })) }; }
  for (const ref of refs) {
    const value = records.get(ref.id);
    const canonicalScope = value?.record && typeof value.record === "object" ? (value.record as { investigationId?: unknown }).investigationId : undefined;
    const reason = ref.investigationId !== investigationId ? "out_of_scope"
      : !value ? "unresolved" : !value.authorized ? "unauthorized"
      : value.revoked ? "revoked" : value.deleted ? "deleted" : value.superseded ? "superseded"
      : canonicalScope !== investigationId ? "out_of_scope"
      : value.sourceVersion !== ref.sourceVersion ? "stale" : undefined;
    if (reason) dropped.push({ id: ref.id, reason });
    else accepted.set(ref.id, value!);
  }
  for (const item of dropped) accepted.delete(item.id);
  return { accepted, dropped };
}
export class ElasticSearch {
  private fixtureStore: Projection[];
  constructor(readonly mode: "live" | "local" | "fixture" | "blocked" | "not_implemented", private resolver: CanonicalResolver,
    private client?: SearchClient, fixtureStore: Iterable<Projection> = []) {
    this.fixtureStore = [...fixtureStore];
  }
  async searchEvidence(input: SearchInput): Promise<SearchResult> {
    const unavailable = (reason: string): SearchResult => ({ mode: "blocked", hits: [], dropped: [], reason, usage: "evidence_only" });
    if (!input.investigationId.trim()) throw new Error("investigationId is required");
    if (this.mode === "blocked" || this.mode === "not_implemented") return unavailable("Elastic retrieval unavailable");
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 10)));
    let hits: { doc: EvidenceDocument; score: number | null; highlight: Record<string, string[]> }[];
    if (this.mode === "fixture") {
      hits = [...this.fixtureStore].map(p => p.body).filter(d => d.investigationId === input.investigationId
        && (!input.environmentId || d.environmentId === input.environmentId)
        && (!input.docTypes?.length || input.docTypes.includes(d.docType))
        && (!input.kinds?.length || input.kinds.includes(String(d.kind)))
        && (!input.failureKinds?.length || input.failureKinds.some(k => Array.isArray(d.failureKinds) && d.failureKinds.includes(k)))
        && (!input.query || d.text.toLowerCase().includes(input.query.toLowerCase())))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map(doc => ({ doc, score: null, highlight: {} }));
    } else {
      if (!this.client) return unavailable("Elastic retrieval unavailable");
      const filter: estypes.QueryDslQueryContainer[] = [{ term: { investigationId: input.investigationId } }];
      if (input.environmentId) filter.push({ term: { environmentId: input.environmentId } });
      for (const [key, values] of [["docType", input.docTypes], ["failureKinds", input.failureKinds], ["kind", input.kinds]] as const) {
        if (values?.length) filter.push({ terms: { [key]: values } });
      }
      try {
        const response = await this.client.search({ index: Object.values(INDICES), size: limit,
          query: { bool: { filter, must: input.query ? [{ multi_match: { query: input.query, fields: ["text"] } }] : [{ match_all: {} }] } },
          highlight: { fields: { text: {} } } });
        hits = response.hits.hits.flatMap(h => h._source ? [{ doc: h._source, score: h._score ?? null, highlight: h.highlight ?? {} }] : []);
      } catch { return unavailable("Elastic retrieval failed"); }
    }
    const refs = hits.map(({ doc }) => ({ docType: doc.docType, id: doc.id, investigationId: doc.investigationId, sourceVersion: doc.sourceVersion }));
    const { accepted, dropped } = await resolveEvidence(refs, input.investigationId, this.resolver);
    return { mode: this.mode, usage: "evidence_only", dropped,
      hits: hits.flatMap(({ doc, score, highlight }) => accepted.has(doc.id) ? [{ docType: doc.docType, id: doc.id, score, highlight, canonical: accepted.get(doc.id)!.record, mode: this.mode as ResolvedHit["mode"] }] : []) };
  }
}
export const searchEvidence = (input: SearchInput, search: ElasticSearch) => search.searchEvidence(input);
