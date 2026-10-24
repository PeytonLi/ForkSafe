import { createHash } from "node:crypto";
import { z } from "zod";
import type { estypes } from "@elastic/elasticsearch";
import type { DocType, IndexResult, Projection } from "./indexer.ts";
import { INDEX_ERRORS_INDEX, INDICES } from "./mappings.ts";

export const DOC_TYPES = Object.keys(INDICES) as DocType[];

export interface IndexErrorRecord {
  id: string; index: string; docId: string; idempotencyKey: string; errorType: string; errorCode?: string;
  status?: number; attempt: number; recordedAt: number; investigationId?: string;
}
export const IndexErrorContext = z.object({
  idempotencyKey: z.string().min(1).max(512), attempt: z.number().int().min(0), now: z.number().int().nonnegative(),
  investigationId: z.string().min(1).max(128).optional(),
});
export type IndexErrorContext = z.infer<typeof IndexErrorContext>;

/** Builds error-log records for failed per-document results. The id is stable per (delivery, attempt, doc), so re-recording is idempotent. */
export function indexErrorRecords(results: IndexResult[], context: IndexErrorContext): IndexErrorRecord[] {
  const ctx = IndexErrorContext.parse(context);
  return results.filter(result => result.result === "error").map(result => ({
    id: createHash("sha256").update(JSON.stringify([ctx.idempotencyKey, ctx.attempt, result.index, result.id])).digest("hex"),
    index: result.index, docId: result.id, idempotencyKey: ctx.idempotencyKey, errorType: result.errorType ?? "transient",
    ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(result.status !== undefined ? { status: result.status } : {}),
    attempt: ctx.attempt, recordedAt: ctx.now, ...(ctx.investigationId ? { investigationId: ctx.investigationId } : {}),
  }));
}

export interface ErrorLogClient { bulk(request: estypes.BulkRequest): Promise<estypes.BulkResponse> }
/** Persists failed indexing results to `forksafe-index-errors`. Returns how many records were stored. */
export async function recordIndexErrors(client: ErrorLogClient, results: IndexResult[], context: IndexErrorContext): Promise<number> {
  const records = indexErrorRecords(results, context);
  if (!records.length) return 0;
  let response: estypes.BulkResponse;
  try {
    response = await client.bulk({ operations: records.flatMap(record => [{ index: { _index: INDEX_ERRORS_INDEX, _id: record.id } }, record]) });
  } catch { throw new Error("Elastic index-error logging failed"); }
  const failed = response.items.filter(item => item.index?.error || (item.index?.status ?? 500) >= 300).length;
  if (failed) throw new Error(`Elastic index-error logging failed for ${failed} record(s)`);
  return records.length;
}

export interface IndexStatus {
  index: string; docType: DocType; exists: boolean; docCount: number | null;
  lastIndexedAt: number | null; ageMs: number | null; error?: string;
}
export interface ElasticStatus {
  mode: "live" | "local" | "fixture"; checkedAt: number; indices: IndexStatus[];
  errors: { index: typeof INDEX_ERRORS_INDEX; state: "ok" | "missing" | "unavailable"; total: number | null; recent: IndexErrorRecord[] };
  healthy: boolean;
}
export interface StatusClient {
  count(request: estypes.CountRequest): Promise<estypes.CountResponse>;
  search<T = unknown>(request: estypes.SearchRequest): Promise<estypes.SearchResponse<T>>;
}
const notFound = (error: unknown) => {
  const meta = (error as { meta?: { statusCode?: number; body?: { error?: { type?: string } } } }).meta;
  return meta?.statusCode === 404 || meta?.body?.error?.type === "index_not_found_exception";
};
const finish = (mode: ElasticStatus["mode"], checkedAt: number, indices: IndexStatus[], errors: ElasticStatus["errors"]): ElasticStatus => ({
  mode, checkedAt, indices, errors,
  healthy: indices.every(item => item.exists && !item.error) && errors.state === "ok" && errors.recent.length === 0,
});

/** Per-index doc counts, newest indexedAt, and recent dispatcher-recorded indexing errors. */
export async function status(client: StatusClient, options: { now: number; recentErrors?: number; mode?: "live" | "local" }): Promise<ElasticStatus> {
  const recentLimit = Math.max(1, Math.min(100, Math.floor(options.recentErrors ?? 20)));
  const indices = await Promise.all(DOC_TYPES.map(async (docType): Promise<IndexStatus> => {
    const index = INDICES[docType];
    try {
      const [count, latest] = await Promise.all([
        client.count({ index }),
        client.search({ index, size: 0, aggs: { lastIndexedAt: { max: { field: "indexedAt" } } } }),
      ]);
      const value = (latest.aggregations?.lastIndexedAt as estypes.AggregationsMaxAggregate | undefined)?.value;
      const lastIndexedAt = typeof value === "number" && Number.isFinite(value) ? value : null;
      return { index, docType, exists: true, docCount: count.count, lastIndexedAt, ageMs: lastIndexedAt === null ? null : Math.max(0, options.now - lastIndexedAt) };
    } catch (error) {
      if (notFound(error)) return { index, docType, exists: false, docCount: null, lastIndexedAt: null, ageMs: null, error: "missing; run bootstrap" };
      return { index, docType, exists: true, docCount: null, lastIndexedAt: null, ageMs: null, error: "unavailable" };
    }
  }));
  let errors: ElasticStatus["errors"];
  try {
    const response = await client.search<IndexErrorRecord>({ index: INDEX_ERRORS_INDEX, size: recentLimit, sort: [{ recordedAt: "desc" }], track_total_hits: true });
    const total = typeof response.hits.total === "number" ? response.hits.total : response.hits.total?.value ?? null;
    errors = { index: INDEX_ERRORS_INDEX, state: "ok", total, recent: response.hits.hits.flatMap(hit => hit._source ? [hit._source] : []) };
  } catch (error) {
    errors = { index: INDEX_ERRORS_INDEX, state: notFound(error) ? "missing" : "unavailable", total: null, recent: [] };
  }
  return finish(options.mode ?? "live", options.now, indices, errors);
}

/** Fixture equivalent of `status` over an in-memory projection store and error log. */
export function fixtureStatus(projections: Iterable<Projection>, errors: IndexErrorRecord[], now: number, recentErrors = 20): ElasticStatus {
  const docs = [...projections];
  const indices = DOC_TYPES.map((docType): IndexStatus => {
    const own = docs.filter(doc => doc.index === INDICES[docType]);
    const lastIndexedAt = own.length ? Math.max(...own.map(doc => doc.body.indexedAt)) : null;
    return { index: INDICES[docType], docType, exists: true, docCount: own.length, lastIndexedAt, ageMs: lastIndexedAt === null ? null : Math.max(0, now - lastIndexedAt) };
  });
  const recent = [...errors].sort((a, b) => b.recordedAt - a.recordedAt).slice(0, recentErrors);
  return finish("fixture", now, indices, { index: INDEX_ERRORS_INDEX, state: "ok", total: errors.length, recent });
}

export const CanonicalVersion = z.object({
  docType: z.enum(DOC_TYPES as [DocType, ...DocType[]]), id: z.string().min(1).max(512),
  sourceVersion: z.string().min(1).max(256), investigationId: z.string().min(1).max(128),
}).strict();
export type CanonicalVersion = z.infer<typeof CanonicalVersion>;
export interface IndexedVersion { docType: DocType; id: string; sourceVersion: string; investigationId: string }
export interface ReconcileReport {
  mode: "live" | "local" | "fixture"; investigationIds: string[]; canonicalCount: number; indexedCount: number;
  missing: CanonicalVersion[]; extra: IndexedVersion[];
  stale: { docType: DocType; id: string; canonicalVersion: string; indexedVersion: string }[];
  scopeMismatch: { docType: DocType; id: string; canonicalInvestigationId: string; indexedInvestigationId: string }[];
  duplicates: { docType: DocType; id: string; copies: number }[];
  truncated: boolean; inSync: boolean;
}
const key = (item: { docType: string; id: string }) => `${item.docType}\u0000${item.id}`;

/** Pure diff of a canonical id+version list against indexed projections within the given investigations. */
export function diffProjections(canonicalInput: CanonicalVersion[], indexed: IndexedVersion[], options: { investigationIds?: string[]; truncated?: boolean; mode?: ReconcileReport["mode"] } = {}): ReconcileReport {
  const canonical = z.array(CanonicalVersion).max(50_000).parse(canonicalInput);
  const wanted = new Map<string, CanonicalVersion>();
  for (const item of canonical) {
    if (wanted.has(key(item))) throw new TypeError(`Duplicate canonical entry ${item.docType} ${item.id}`);
    wanted.set(key(item), item);
  }
  const investigationIds = [...new Set([...(options.investigationIds ?? []), ...canonical.map(item => item.investigationId)])].sort();
  const scope = new Set(investigationIds);
  const seen = new Map<string, IndexedVersion[]>();
  for (const doc of indexed) {
    const owned = wanted.get(key(doc));
    if (!scope.has(doc.investigationId) && !owned) continue;
    seen.set(key(doc), [...(seen.get(key(doc)) ?? []), doc]);
  }
  const report: ReconcileReport = { mode: options.mode ?? "fixture", investigationIds, canonicalCount: canonical.length, indexedCount: 0,
    missing: [], extra: [], stale: [], scopeMismatch: [], duplicates: [], truncated: options.truncated ?? false, inSync: false };
  for (const [k, docs] of seen) {
    report.indexedCount += docs.length;
    const first = docs[0]!;
    if (docs.length > 1) report.duplicates.push({ docType: first.docType, id: first.id, copies: docs.length });
    const owned = wanted.get(k);
    if (!owned) { report.extra.push(...docs); continue; }
    for (const doc of docs) {
      if (doc.investigationId !== owned.investigationId) report.scopeMismatch.push({ docType: doc.docType, id: doc.id, canonicalInvestigationId: owned.investigationId, indexedInvestigationId: doc.investigationId });
      else if (doc.sourceVersion !== owned.sourceVersion) report.stale.push({ docType: doc.docType, id: doc.id, canonicalVersion: owned.sourceVersion, indexedVersion: doc.sourceVersion });
    }
  }
  for (const [k, item] of wanted) if (!seen.has(k)) report.missing.push(item);
  const byKey = (a: { docType: string; id: string }, b: { docType: string; id: string }) => key(a).localeCompare(key(b));
  for (const list of [report.missing, report.extra, report.stale, report.scopeMismatch, report.duplicates]) list.sort(byKey);
  report.inSync = !report.truncated && !report.missing.length && !report.extra.length && !report.stale.length
    && !report.scopeMismatch.length && !report.duplicates.length;
  return report;
}

export interface ReconcileOptions { investigationIds?: string[]; maxDocs?: number; pageSize?: number; mode?: "live" | "local" }
/** Reports missing, extra, stale, out-of-scope and duplicate projections against a canonical id+version list. Read-only. */
export async function reconcile(canonicalInput: CanonicalVersion[], client: Pick<StatusClient, "search">, options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const canonical = z.array(CanonicalVersion).max(50_000).parse(canonicalInput);
  const investigationIds = [...new Set([...(options.investigationIds ?? []), ...canonical.map(item => item.investigationId)])];
  if (!investigationIds.length) throw new TypeError("reconcile needs at least one investigation scope");
  const maxDocs = Math.max(1, Math.min(100_000, Math.floor(options.maxDocs ?? 10_000)));
  const pageSize = Math.max(1, Math.min(1000, Math.floor(options.pageSize ?? 500)));
  const indexed: IndexedVersion[] = [];
  const wantedIds = [...new Set(canonical.map(item => item.id))];
  // Canonical ids are also looked up outside the scope so a mis-scoped projection surfaces as scopeMismatch, not missing.
  const should: estypes.QueryDslQueryContainer[] = [{ terms: { investigationId: investigationIds } }];
  for (let i = 0; i < wantedIds.length; i += 1000) should.push({ terms: { id: wantedIds.slice(i, i + 1000) } });
  let after: estypes.SortResults | undefined;
  let truncated = false;
  try {
    for (;;) {
      const response = await client.search<IndexedVersion>({ index: Object.values(INDICES), size: pageSize, ignore_unavailable: true,
        _source: ["docType", "id", "sourceVersion", "investigationId"], query: { bool: { should, minimum_should_match: 1 } },
        sort: [{ docType: "asc" }, { id: "asc" }], ...(after ? { search_after: after } : {}) });
      const hits = response.hits.hits;
      for (const hit of hits) if (hit._source) indexed.push(hit._source);
      if (indexed.length >= maxDocs) { truncated = hits.length === pageSize; break; }
      if (hits.length < pageSize) break;
      after = hits.at(-1)?.sort;
      if (!after) break;
    }
  } catch { throw new Error("Elastic reconcile query failed"); }
  return diffProjections(canonical, indexed, { investigationIds, truncated, mode: options.mode ?? "live" });
}

/** Fixture equivalent of `reconcile` over an in-memory projection store. */
export const reconcileProjections = (canonical: CanonicalVersion[], projections: Iterable<Projection>, investigationIds?: string[]) =>
  diffProjections(canonical, [...projections].map(({ body }) => ({ docType: body.docType, id: body.id, sourceVersion: body.sourceVersion, investigationId: body.investigationId })),
    { investigationIds, mode: "fixture" });
