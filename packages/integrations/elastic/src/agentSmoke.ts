import { createHash, randomUUID } from "node:crypto";
import { ExperimentResult, Finding, type EnvConfig } from "@forksafe/contracts";
import type { estypes } from "@elastic/elasticsearch";
import { agentBuilderReadiness, elasticReadiness } from "./config.ts";
import { ForkSafeEvidenceAgent, type AskResult, type EnsureResult } from "./evidenceAgent.ts";
import { canonicalJSON, toDocuments, type Projection } from "./indexer.ts";
import { INDICES } from "./mappings.ts";
import { resolveEvidence, type CanonicalRecord, type CanonicalResolver } from "./search.ts";
import { reconcile, recordIndexErrors, status, type ElasticStatus, type ReconcileReport, type StatusClient } from "./status.ts";

export const SYNTHETIC_PREFIX = "synthetic-";
export const SYNTHETIC_SOURCE = "synthetic-smoke";

export interface AgentSmokeClient extends StatusClient {
  bulk(request: estypes.BulkRequest): Promise<estypes.BulkResponse>;
  deleteByQuery(request: estypes.DeleteByQueryRequest): Promise<estypes.DeleteByQueryResponse>;
  indices: { refresh(request: estypes.IndicesRefreshRequest): Promise<unknown> };
}

const hash = (value: unknown) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
/** Rewrites a projection so it is unmistakably synthetic: `synthetic-` doc ids, synthetic source system and text marker. */
export function synthesize(projection: Projection): Projection {
  const prefix = (value: unknown) => typeof value === "string" ? `${SYNTHETIC_PREFIX}${value}` : value;
  const { contentHash: _hash, idempotencyKey: _key, indexedAt, ...content } = projection.body;
  const body = { ...content, id: prefix(content.id) as string, sourceSystem: SYNTHETIC_SOURCE, text: `[SYNTHETIC] ${content.text}`,
    ...(content.findingId ? { findingId: prefix(content.findingId) as string } : {}),
    ...(content.experimentId ? { experimentId: prefix(content.experimentId) as string } : {}) };
  const contentHash = hash(body);
  return { index: projection.index, id: body.id, body: { ...body, contentHash, idempotencyKey: `${SYNTHETIC_SOURCE}:${body.id}:${contentHash}`, indexedAt } };
}

/** Three clearly synthetic records (finding, one evidence item, experiment) in a fresh investigation. */
export function agentSmokeRecords(now = Date.now()) {
  const investigationId = randomUUID();
  const environmentId = randomUUID();
  const experiment = ExperimentResult.parse({ id: randomUUID(), investigationId, environmentId, attemptId: randomUUID(), epoch: 0,
    simCase: { caseId: `synthetic-agent-smoke-${investigationId}`, suite: "public", seed: 7 }, status: "physics_failure",
    failureKinds: ["forbidden_contact"], completed: false, engineVersion: "synthetic-smoke", assetsSha256: "0".repeat(64),
    controllerSha256: "1".repeat(64), startedAtMs: now });
  const finding = Finding.parse({ id: randomUUID(), investigationId, environmentId, kind: "behavioral_note", createdAtMs: now,
    summary: `Synthetic ForkSafe agent smoke: the gripper finger touched the divider (forbidden contact) while carrying at 0.06 m, below the 0.10 m divider. No real robot was run.`,
    evidence: [{ kind: "log_excerpt", experimentId: experiment.id,
      excerpt: "Synthetic agent smoke log: forbidden_contact finger/divider at frame 412, carry height 0.06 m. This item is revoked canonically." }] });
  const projections = [...toDocuments(finding, { now }), ...toDocuments(experiment, { now })].map(synthesize);
  return { investigationId, environmentId, finding, experiment, projections };
}

export interface AgentSmokeResult {
  investigationId: string; readiness: { elastic: string; agentBuilder: string };
  indexed: { id: string; index: string; result: string }[];
  ensure: { first: EnsureResult; second: EnsureResult };
  statusBefore: Pick<ElasticStatus, "healthy" | "errors"> & { indices: { index: string; docCount: number | null; lastIndexedAt: number | null }[] };
  reconcile: Pick<ReconcileReport, "inSync" | "canonicalCount" | "indexedCount" | "missing" | "extra" | "stale">;
  transcript: { question: string; agentId: string; status: AskResult["status"]; answer: string; toolIds: string[]; conversationId?: string;
    citations: { docType: string; id: string }[]; droppedCitations: { id: string; reason: string }[]; malformedCitations: number };
  recheck: { revokedId: string; revokedCitedByAgent: boolean; revokedDropped: boolean; revokedNeverAccepted: boolean; directRecheck: { id: string; reason: string }[] };
  cleanup: string; ok: boolean;
}

export async function runAgentSmoke(env: EnvConfig, client: AgentSmokeClient, options: { fetcher?: typeof fetch; now?: number } = {}): Promise<AgentSmokeResult> {
  const readiness = { elastic: elasticReadiness(env, 0).mode, agentBuilder: agentBuilderReadiness(env, 0).mode };
  if (readiness.elastic !== "live" || readiness.agentBuilder !== "live") throw new Error("Agent smoke requires ELASTIC_MODE=cloud and ELASTIC_AGENT_BUILDER_MODE=cloud with credentials");
  const now = options.now ?? Date.now();
  const { investigationId, finding, experiment, projections } = agentSmokeRecords(now);
  const revokedId = projections.find(p => p.body.docType === "evidence")!.id;
  const canonical = new Map<string, CanonicalRecord>(projections.map(p => [p.id, {
    authorized: true, revoked: p.id === revokedId, sourceVersion: p.body.sourceVersion,
    record: p.body.docType === "finding" ? finding : p.body.docType === "experiment_result" ? experiment : { ...finding.evidence[0], investigationId },
  }]));
  const resolver: CanonicalResolver = { resolve: async refs => new Map(refs.flatMap(ref => {
    const value = canonical.get(ref.id);
    return value && projections.some(p => p.id === ref.id && p.body.docType === ref.docType) ? [[ref.id, value] as const] : [];
  })) };
  const indices = Object.values(INDICES);
  let cleanup = "pending";
  try {
    const response = await client.bulk({ refresh: "wait_for", operations: projections.flatMap(p => [{ index: { _index: p.index, _id: p.id } }, p.body]) });
    const indexed = projections.map((p, i) => {
      const item = response.items[i]?.index;
      const failed = !item || item.error || item.status >= 300;
      return { id: p.id, index: p.index, result: failed ? "error" : String(item.result ?? "updated"), status: item?.status,
        errorCode: (item?.error as { type?: string } | undefined)?.type };
    });
    if (indexed.some(doc => doc.result === "error")) {
      await recordIndexErrors(client, indexed.map(doc => ({ index: doc.index, id: doc.id, result: doc.result === "error" ? "error" as const : "created" as const,
        status: doc.status, errorType: "transient" as const, ...(doc.errorCode ? { errorCode: doc.errorCode } : {}) })),
        { idempotencyKey: `${SYNTHETIC_SOURCE}:${investigationId}`, attempt: 0, now, investigationId }).catch(() => 0);
      throw new Error("Agent smoke indexing failed");
    }
    const agent = new ForkSafeEvidenceAgent(env, resolver, { fetcher: options.fetcher });
    const first = await agent.ensureAgent();
    const second = await agent.ensureAgent();
    const before = await status(client, { now });
    const recon = await reconcile(projections.map(p => ({ docType: p.body.docType, id: p.id, sourceVersion: p.body.sourceVersion, investigationId })), client);
    const question = "Why did the synthetic repair fail? Cite the finding, its evidence item and the experiment result that support the answer.";
    const answer = await agent.ask(question, { investigationId });
    const directRecheck = (await resolveEvidence(projections.map(p => ({ docType: p.body.docType as "finding" | "evidence" | "experiment_result", id: p.id, investigationId, sourceVersion: p.body.sourceVersion })), investigationId, resolver)).dropped;
    const revokedCitedByAgent = answer.citations.some(c => c.id === revokedId) || answer.droppedCitations.some(d => d.id === revokedId);
    const recheck = { revokedId, revokedCitedByAgent,
      revokedDropped: answer.droppedCitations.some(d => d.id === revokedId && d.reason === "revoked"),
      revokedNeverAccepted: !answer.citations.some(c => c.id === revokedId), directRecheck };
    const ok = answer.mode === "live" && answer.citations.length > 0 && recheck.revokedNeverAccepted
      && (!revokedCitedByAgent || recheck.revokedDropped) && directRecheck.some(d => d.id === revokedId && d.reason === "revoked")
      && second.agent.action === "unchanged" && second.tools.every(t => t.action === "unchanged") && recon.inSync;
    return { investigationId, readiness, indexed: indexed.map(({ id, index, result }) => ({ id, index, result })), ensure: { first, second },
      statusBefore: { healthy: before.healthy, errors: before.errors, indices: before.indices.map(({ index, docCount, lastIndexedAt }) => ({ index, docCount, lastIndexedAt })) },
      reconcile: { inSync: recon.inSync, canonicalCount: recon.canonicalCount, indexedCount: recon.indexedCount, missing: recon.missing, extra: recon.extra, stale: recon.stale },
      transcript: { question, agentId: answer.agentId, status: answer.status, answer: answer.answer, toolIds: answer.toolIds, conversationId: answer.conversationId,
        citations: answer.citations.map(({ docType, id }) => ({ docType, id })), droppedCitations: answer.droppedCitations, malformedCitations: answer.malformedCitations },
      recheck, get cleanup() { return cleanup; }, ok };
  } finally {
    // Delete only this run's synthetic documents: exact ids AND investigation AND synthetic source.
    const deleted = await client.deleteByQuery({ index: indices, refresh: true, conflicts: "proceed", query: { bool: { filter: [
      { terms: { id: projections.map(p => p.id) } }, { term: { investigationId } }, { term: { sourceSystem: SYNTHETIC_SOURCE } }] } } });
    if (deleted.failures?.length || deleted.timed_out) throw new Error("Agent smoke cleanup failed");
    const remaining = await client.count({ index: indices, query: { term: { investigationId } } });
    cleanup = `deleted ${deleted.deleted ?? 0} synthetic documents; ${remaining.count} remaining for the investigation`;
  }
}

/** Redacts credentials and service URLs from any printed output. */
export function redactTranscript(value: unknown, env: EnvConfig): string {
  let output = JSON.stringify(value, null, 2);
  for (const secret of [env.ELASTICSEARCH_API_KEY, env.KIBANA_API_KEY, env.ELASTICSEARCH_URL, env.KIBANA_URL]) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  return output.replace(/ApiKey\s+[A-Za-z0-9+/=_-]+/g, "ApiKey [REDACTED]");
}
