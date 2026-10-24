import { createHash } from "node:crypto";
import { CandidateEvaluation, ControllerCandidate, Finding, ExperimentResult, OutboxEntry } from "@forksafe/contracts";
import type { estypes } from "@elastic/elasticsearch";
import { BlockedError } from "./config.js";
import { INDICES } from "./mappings.js";

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
  const experiment = finding.success ? undefined : ExperimentResult.safeParse(record);
  const candidate = finding.success || experiment?.success ? undefined : ControllerCandidate.safeParse(record);
  const evaluation = finding.success || experiment?.success || candidate?.success ? undefined : CandidateEvaluation.safeParse(record);
  let parsed: Finding | ExperimentResult | ControllerCandidate | CandidateEvaluation;
  if (finding.success) parsed = finding.data;
  else if (experiment?.success) parsed = experiment.data;
  else if (candidate?.success) parsed = candidate.data;
  else if (evaluation?.success) parsed = evaluation.data;
  else throw new TypeError("Unsupported Elastic source record");
  const sourceVersion = options.sourceVersion ?? hash(parsed);
  const base = { investigationId: parsed.investigationId,
    ...("environmentId" in parsed && parsed.environmentId ? { environmentId: parsed.environmentId } : {}),
    sourceVersion, sourceSystem: options.sourceSystem ?? "spacetimedb",
    sourceEntity: finding.success ? "finding" : experiment?.success ? "experiment_result" : candidate?.success ? "candidate" : "evaluation",
    sourceId: parsed.id,
    createdAt: "startedAtMs" in parsed ? parsed.startedAtMs
      : "submittedAtMs" in parsed ? parsed.submittedAtMs
        : "createdAtMs" in parsed ? parsed.createdAtMs : 0 };
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
  if (experiment && experiment.success) {
    const r = experiment.data;
    return [make("experiment_result", r.id, { experimentId: r.id, candidateId: r.candidateId,
      status: r.status, failureKinds: r.failureKinds, suite: r.simCase.suite, caseId: r.simCase.caseId,
      artifactId: r.traceArtifactId ?? r.replayArtifactId, text: `${r.status}: ${r.failureKinds.join(", ")}` })];
  }
  if (candidate && candidate.success) {
    const r = candidate.data;
    return [make("candidate", r.id, { candidateId: r.id, status: r.status,
      controllerSha256: r.controllerSha256, changedFunctions: r.changedFunctions,
      text: `Candidate ${r.status}; controller ${r.controllerSha256}; changed functions: ${r.changedFunctions.join(", ") || "none"}` })];
  }
  if (!evaluation?.success) throw new TypeError("Unsupported Elastic source record");
  const r = evaluation.data;
  const passedCases = r.cases.filter(item => item.status === "passed").length;
  return [make("evaluation", r.id, { candidateId: r.candidateId, status: r.status,
    suite: r.suite, text: `Evaluation ${r.status}; suite ${r.suite}; cases ${passedCases}/${r.cases.length}` })];
}
export interface BulkClient {
  bulk(request: estypes.BulkRequest): Promise<estypes.BulkResponse>;
  deleteByQuery?(request: estypes.DeleteByQueryRequest): Promise<unknown>;
}
export type IndexErrorType = "permanent" | "transient" | "auth";
export type IndexResult = {
  index: string;
  id: string;
  result: "created" | "updated" | "noop" | "error";
  status?: number;
  errorType?: IndexErrorType;
  errorCode?: string;
};

export function classifyBulkFailure(status: number | undefined, type?: string): IndexErrorType {
  if (status === 401 || status === 403) return "auth";
  const normalized = type?.toLowerCase() ?? "";
  if (["mapper_parsing_exception", "parse_exception", "illegal_argument_exception", "strict_dynamic_mapping_exception"].includes(normalized) || status === 400) return "permanent";
  return "transient";
}
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
        if (item && !item.error && item.status < 300) {
          return { index: doc.index, id: doc.id, status: item.status, result: item.result === "created" ? "created" : item.result === "noop" ? "noop" : "updated" };
        }
        const failure = item?.error as { type?: string } | undefined;
        return { index: doc.index, id: doc.id, status: item?.status, result: "error", errorType: classifyBulkFailure(item?.status, failure?.type), ...(failure?.type ? { errorCode: failure.type } : {}) };
      });
    } catch { return docs.map(doc => ({ index: doc.index, id: doc.id, result: "error", errorType: "transient" })); }
  }
  async deleteBySource({ sourceId, investigationId }: { sourceId: string; investigationId?: string }): Promise<void> {
    if (this.mode === "blocked" || this.mode === "not_implemented") throw new BlockedError();
    if (this.mode === "fixture") {
      for (const [key, projection] of this.store) {
        if (projection.body.sourceId === sourceId && (!investigationId || projection.body.investigationId === investigationId)) this.store.delete(key);
      }
      return;
    }
    if (!this.client?.deleteByQuery) throw new BlockedError();
    try {
      await this.client.deleteByQuery({
        index: Object.values(INDICES),
        query: { bool: { filter: [
          { term: { sourceId } },
          ...(investigationId ? [{ term: { investigationId } }] : []),
        ] } },
        conflicts: "proceed",
        refresh: true,
      });
    } catch {
      throw new Error("Elastic projection deletion failed");
    }
  }
  async indexOutboxEntry(input: OutboxEntry) {
    const entry = OutboxEntry.parse(input);
    if (entry.destination !== "elastic_index") throw new Error("Unsupported outbox destination");
    const { kind, record } = entry.payload;
    if (kind === "finding") Finding.parse(record);
    else if (kind === "experiment_result") ExperimentResult.parse(record);
    else if (kind === "candidate") ControllerCandidate.parse(record);
    else if (kind === "evaluation") CandidateEvaluation.parse(record);
    else throw new Error("Unsupported elastic payload kind");
    return this.index(record, { idempotencyKey: entry.idempotencyKey, now: entry.createdAtMs });
  }
}
export const indexOutboxEntry = (entry: OutboxEntry, indexer: ElasticIndexer) => indexer.indexOutboxEntry(entry);
