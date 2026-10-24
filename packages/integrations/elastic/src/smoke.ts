import { randomUUID } from "node:crypto";
import { Finding, ExperimentResult, type EnvConfig } from "@forksafe/contracts";
import type { Client } from "@elastic/elasticsearch";
import { elasticReadiness, agentBuilderReadiness } from "./config.ts";
import { ElasticIndexer, canonicalJSON, toDocuments } from "./indexer.ts";
import { ElasticSearch, type CanonicalResolver, type CanonicalRecord } from "./search.ts";
import { AgentBuilder } from "./agentBuilder.ts";
import { INDICES } from "./mappings.ts";

export function smokeRecords() {
  const investigationId = randomUUID();
  const environmentId = randomUUID();
  const now = Date.now();
  const experiment = ExperimentResult.parse({ id: randomUUID(), investigationId, environmentId,
    attemptId: randomUUID(), epoch: 0, simCase: { caseId: `forksafe-smoke-${investigationId}`, suite: "public", seed: 42 },
    status: "physics_failure", failureKinds: ["forbidden_contact"], completed: false,
    engineVersion: "synthetic-smoke", assetsSha256: "0".repeat(64), controllerSha256: "1".repeat(64), startedAtMs: now,
  });
  const finding = Finding.parse({ id: randomUUID(), investigationId, environmentId, kind: "behavioral_note",
    summary: `ForkSafe smoke investigation ${investigationId}: synthetic repair failed because of forbidden contact at frame 3.`,
    evidence: [
      { kind: "log_excerpt", experimentId: experiment.id, excerpt: "Synthetic smoke: forbidden contact at frame 3; no real robot was run." },
      { kind: "log_excerpt", experimentId: experiment.id, excerpt: "Synthetic smoke: this evidence is revoked by the canonical resolver." },
    ], createdAtMs: now,
  });
  return { investigationId, finding, experiment };
}

export async function runSmoke(env: EnvConfig, client: Client, options: { keep?: boolean; fetcher?: typeof fetch } = {}) {
  const readiness = { elastic: elasticReadiness(env, Date.now()), agentBuilder: agentBuilderReadiness(env, Date.now()) };
  if (readiness.elastic.mode !== "live" || readiness.agentBuilder.mode !== "live") throw new Error("Smoke requires configured cloud modes for Elastic and Agent Builder");
  const { investigationId, finding, experiment } = smokeRecords();
  const records = [finding, experiment];
  const docs = records.flatMap(record => toDocuments(record));
  const revokedId = `${finding.id}:1`;
  const canonical = new Map<string, CanonicalRecord>(docs.map(doc => [doc.id, {
    authorized: true, revoked: doc.id === revokedId, sourceVersion: doc.body.sourceVersion,
    record: doc.body.docType === "finding" ? finding : doc.body.docType === "experiment_result" ? experiment
      : { ...finding.evidence[Number(doc.id.split(":").at(-1))], investigationId },
  }]));
  const resolver: CanonicalResolver = { resolve: async refs => new Map(refs.flatMap(ref => {
    const value = canonical.get(ref.id);
    return value ? [[ref.id, value] as const] : [];
  })) };
  const indexer = new ElasticIndexer("live", client);
  const indices = Object.values(INDICES);
  const snapshot = async () => {
    const response = await client.mget({ docs: docs.map(doc => ({ _index: doc.index, _id: doc.id })) });
    return response.docs.map(doc => {
      if (!("found" in doc) || !doc.found) throw new Error("Smoke document missing after indexing");
      return canonicalJSON(doc._source);
    });
  };
  let cleanup = "pending";
  try {
    const first = (await Promise.all(records.map(record => indexer.index(record)))).flat();
    if (first.some(doc => doc.result === "error")) throw new Error("Smoke initial indexing failed");
    await client.indices.refresh({ index: indices });
    const before = await snapshot();
    const second = (await Promise.all(records.map(record => indexer.index(record)))).flat();
    if (second.some(doc => !["updated", "noop"].includes(doc.result))) throw new Error("Smoke redelivery failed");
    await client.indices.refresh({ index: indices });
    const identicalBodies = canonicalJSON(before) === canonicalJSON(await snapshot());
    if (!identicalBodies) throw new Error("Smoke redelivery changed document bodies");
    const search = new ElasticSearch("live", resolver, client);
    const results = await search.searchEvidence({ query: "", investigationId, limit: 10 });
    if (results.mode !== "live" || results.hits.length !== 3 || !results.dropped.some(hit => hit.id === revokedId && hit.reason === "revoked")) {
      throw new Error("Smoke scoped retrieval or canonical revocation check failed");
    }
    let converseShape: Record<string, unknown> = {};
    const inspectFetch: typeof fetch = async (input, init) => {
      const response = await (options.fetcher ?? fetch)(input, init);
      try {
        const data = await response.clone().json() as Record<string, unknown>;
        const message = data.response && typeof data.response === "object" ? (data.response as Record<string, unknown>).message : undefined;
        converseShape = { status: response.status, keys: Object.keys(data),
          responseKeys: data.response && typeof data.response === "object" ? Object.keys(data.response) : [],
          messageType: typeof message, stepCount: Array.isArray(data.steps) ? data.steps.length : null,
        };
      } catch { converseShape = { status: response.status, json: false }; }
      return response;
    };
    const agent = await new AgentBuilder(env, resolver, search, inspectFetch).ask({ investigationId, agentId: "elastic-ai-agent",
      input: `Why did the synthetic repair fail? Search only forksafe-findings, forksafe-evidence, forksafe-experiments for investigationId ${investigationId}. Use read-only search; do not search any other investigation. Cite exact document ids and sourceVersion.` });
    return { investigationId, readiness, indexing: { first, second, identicalBodies },
      search: { mode: results.mode, hitIds: results.hits.map(hit => hit.id), dropped: results.dropped, usage: results.usage },
      agent: { mode: agent.mode, reason: agent.reason, answerExcerpt: agent.answer?.slice(0, 500), citationCount: agent.citations?.length ?? 0,
        droppedCitationCount: agent.droppedCitations?.length ?? 0, conversationId: agent.conversationId, usage: agent.usage, scoreAffecting: agent.scoreAffecting, converseShape },
      get cleanup() { return cleanup; },
    };
  } finally {
    if (options.keep) cleanup = "kept (--keep)";
    else {
      const deleted = await client.deleteByQuery({ index: indices, query: { term: { investigationId } }, refresh: true });
      if (deleted.failures?.length || deleted.timed_out) throw new Error("Smoke document cleanup failed");
      cleanup = `deleted ${deleted.deleted ?? 0} smoke documents`;
    }
  }
}

export function sanitizeSummary(value: unknown, env: EnvConfig): string {
  let output = JSON.stringify(value, null, 2);
  for (const secret of [env.ELASTICSEARCH_URL, env.ELASTICSEARCH_API_KEY, env.KIBANA_URL, env.KIBANA_API_KEY]) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}
