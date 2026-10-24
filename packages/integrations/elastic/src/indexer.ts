import { createHash } from "node:crypto";
import { Finding, ExperimentResult, OutboxEntry } from "@forksafe/contracts";
import type { estypes } from "@elastic/elasticsearch";
import { BlockedError } from "./config.ts";
import { INDICES } from "./mappings.ts";

export type DocType = keyof typeof INDICES;
export interface EvidenceDocument {
  id: string; docType: DocType; investigationId: string; sourceVersion: string;
  sourceSystem: string; sourceEntity: string; sourceId: string; text: string;
  contentHash: string; idempotencyKey: string; createdAt: number; indexedAt: number;
  [key: string]: string | number | string[] | undefined;
}
export interface Projection { index: string; id: string; body: EvidenceDocument }
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
export interface ProjectionOptions { idempotencyKey?: string; now?: number; sourceVersion?: string; sourceSystem?: string }
export function toDocuments(record: unknown, options: ProjectionOptions = {}): Projection[] {
  const finding = Finding.safeParse(record);
  const parsed = finding.success ? finding.data : ExperimentResult.parse(record);
  const sourceVersion = options.sourceVersion ?? hash(parsed);
  const base = { investigationId: parsed.investigationId, environmentId: parsed.environmentId,
    sourceVersion, sourceSystem: options.sourceSystem ?? "spacetimedb", sourceEntity: finding.success ? "finding" : "experiment_result",
    sourceId: parsed.id, createdAt: "createdAtMs" in parsed ? parsed.createdAtMs : parsed.startedAtMs };
  const make = (docType: DocType, id: string, fields: { text: string } & Record<string, string | string[] | undefined>): Projection => {
    const content = { ...base, docType, id, ...fields };
    const contentHash = hash(content);
    return { index: INDICES[docType], id, body: { ...content, contentHash,
      idempotencyKey: options.idempotencyKey ?? `${docType}:${id}:${contentHash}`, indexedAt: options.now ?? base.createdAt } };
  };
  if (finding.success) {
    const f = finding.data;
    return [make("finding", f.id, { findingId: f.id, sessionId: f.sessionId, kind: f.kind, text: f.summary }),
      ...f.evidence.map((e, i) => make("evidence", `${f.id}:${i}`, { findingId: f.id, sessionId: f.sessionId, kind: e.kind, artifactId: e.artifactId, experimentId: e.experimentId, text: e.excerpt ?? canonicalJSON(e.locator) }))];
  }
  const r = ExperimentResult.parse(parsed);
  return [make("experiment_result", r.id, { experimentId: r.id, candidateId: r.candidateId,
    status: r.status, failureKinds: r.failureKinds, suite: r.simCase.suite, caseId: r.simCase.caseId,
    artifactId: r.traceArtifactId ?? r.replayArtifactId, text: `${r.status}: ${r.failureKinds.join(", ")}` })];
}
export interface BulkClient { bulk(request: estypes.BulkRequest): Promise<estypes.BulkResponse> }
export type IndexResult = { index: string; id: string; result: "created" | "updated" | "noop" | "error" };
export class ElasticIndexer {
  readonly store = new Map<string, Projection>();
  constructor(readonly mode: "live" | "local" | "fixture" | "blocked" | "not_implemented", private client?: BulkClient) {}
  async index(record: unknown, options: ProjectionOptions & { refresh?: boolean | "wait_for" } = {}): Promise<IndexResult[]> {
    if (this.mode === "blocked" || this.mode === "not_implemented") throw new BlockedError();
    const docs = toDocuments(record, options);
    if (this.mode === "fixture") return docs.map(doc => {
      const key = `${doc.index}/${doc.id}`;
      const old = this.store.get(key);
      this.store.set(key, doc);
      return { index: doc.index, id: doc.id, result: old ? canonicalJSON(old.body) === canonicalJSON(doc.body) ? "noop" : "updated" : "created" };
    });
    if (!this.client) throw new BlockedError();
    try {
      const response = await this.client.bulk({ refresh: options.refresh, operations: docs.flatMap(doc => [{ index: { _index: doc.index, _id: doc.id } }, doc.body]) });
      return docs.map((doc, i) => {
        const item = response.items[i]?.index;
        return { index: doc.index, id: doc.id, result: item && !item.error && item.status < 300 ? item.result === "created" ? "created" : item.result === "noop" ? "noop" : "updated" : "error" };
      });
    } catch { return docs.map(doc => ({ index: doc.index, id: doc.id, result: "error" })); }
  }
  async indexOutboxEntry(input: OutboxEntry) {
    const entry = OutboxEntry.parse(input);
    if (entry.destination !== "elastic_index") throw new Error("Unsupported outbox destination");
    const { kind, record } = entry.payload;
    if (kind === "finding") Finding.parse(record);
    else if (kind === "experiment_result") ExperimentResult.parse(record);
    else throw new Error("Unsupported elastic payload kind");
    return this.index(record, { idempotencyKey: entry.idempotencyKey, now: entry.createdAtMs });
  }
}
export const indexOutboxEntry = (entry: OutboxEntry, indexer: ElasticIndexer) => indexer.indexOutboxEntry(entry);
