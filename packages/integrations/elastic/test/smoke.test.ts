import { describe, expect, it, vi } from "vitest";
import type { Client } from "@elastic/elasticsearch";
import { EnvConfig, ExperimentResult, Finding } from "@forksafe/contracts";
import { runSmoke, sanitizeSummary, smokeRecords } from "../src/smoke.ts";
import type { EvidenceDocument } from "../src/indexer.ts";

const env = EnvConfig.parse({ ELASTIC_MODE: "cloud", ELASTIC_AGENT_BUILDER_MODE: "cloud",
  ELASTICSEARCH_URL: "https://es.invalid", ELASTICSEARCH_API_KEY: "es-secret",
  KIBANA_URL: "https://kibana.invalid", KIBANA_API_KEY: "kibana-secret" });

function transport() {
  const store = new Map<string, EvidenceDocument>();
  const bulk = vi.fn(async ({ operations }: { operations: unknown[] }) => {
    const items = [];
    for (let i = 0; i < operations.length; i += 2) {
      const operation = operations[i] as { index: { _index: string; _id: string } };
      const key = `${operation.index._index}/${operation.index._id}`;
      const existed = store.has(key);
      store.set(key, JSON.parse(JSON.stringify(operations[i + 1])));
      items.push({ index: { status: existed ? 200 : 201, result: existed ? "updated" : "created" } });
    }
    return { items };
  });
  const mget = vi.fn(async ({ docs }: { docs: { _index: string; _id: string }[] }) => ({ docs: docs.map(doc => {
    const body = store.get(`${doc._index}/${doc._id}`);
    return { found: !!body, _source: body };
  }) }));
  const search = vi.fn(async () => ({ hits: { hits: [...store.values()].map(doc => ({ _source: doc, _score: 1 })) } }));
  const refresh = vi.fn(async () => ({}));
  const deleteByQuery = vi.fn(async () => {
    const deleted = store.size;
    store.clear();
    return { deleted };
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
    conversation_id: "smoke-conversation", steps: [{ type: "tool_call" }], response: { message: "Unstructured answer without verifiable citations" },
  })));
  const client = { bulk, mget, search, indices: { refresh }, deleteByQuery } as unknown as Client;
  return { client, store, bulk, mget, search, refresh, deleteByQuery, fetcher };
}

describe("live smoke orchestration (hermetic)", () => {
  it("builds fresh schema-valid smoke records with two evidence items", () => {
    const first = smokeRecords();
    const second = smokeRecords();
    expect(first.investigationId).not.toBe(second.investigationId);
    expect(Finding.parse(first.finding).evidence).toHaveLength(2);
    expect(ExperimentResult.parse(first.experiment).simCase.caseId).toContain(first.investigationId);
    expect(first.finding.summary).toContain("synthetic");
  });
  it("indexes twice, compares actual stored bodies, resolves revoked evidence and cleans up", async () => {
    const fake = transport();
    const result = await runSmoke(env, fake.client, { fetcher: fake.fetcher });
    expect(result.readiness.elastic.mode).toBe("live");
    expect(result.readiness.agentBuilder.mode).toBe("live");
    expect(result.indexing.first.map(doc => doc.result)).toEqual(["created", "created", "created", "created"]);
    expect(result.indexing.second.map(doc => doc.result)).toEqual(["updated", "updated", "updated", "updated"]);
    expect(result.indexing.identicalBodies).toBe(true);
    expect(result.search.hitIds).toHaveLength(3);
    expect(result.search.dropped).toEqual([{ id: expect.stringMatching(/:1$/), reason: "revoked" }]);
    expect(result.agent).toMatchObject({ mode: "live", citationCount: 0, conversationId: "smoke-conversation",
      answerExcerpt: "No fully validated answer available. Inspect authorized citations directly.",
      converseShape: { status: 200, responseKeys: ["message"], messageType: "string", stepCount: 1 } });
    expect(fake.refresh).toHaveBeenCalledTimes(2);
    expect(fake.deleteByQuery).toHaveBeenCalledWith({ index: ["forksafe-findings", "forksafe-evidence", "forksafe-experiments", "forksafe-candidates", "forksafe-evaluations"],
      query: { term: { investigationId: result.investigationId } }, refresh: true });
    expect(result.cleanup).toBe("deleted 4 smoke documents");
    expect(fake.store.size).toBe(0);
  });
  it("keeps smoke records only when explicitly requested", async () => {
    const fake = transport();
    const result = await runSmoke(env, fake.client, { keep: true, fetcher: fake.fetcher });
    expect(result.cleanup).toBe("kept (--keep)");
    expect(fake.store.size).toBe(4);
    expect(fake.deleteByQuery).not.toHaveBeenCalled();
  });
  it("rejects missing cloud readiness before accessing the client", async () => {
    const fake = transport();
    await expect(runSmoke(EnvConfig.parse({}), fake.client)).rejects.toThrow("Smoke requires configured cloud modes");
    expect(fake.bulk).not.toHaveBeenCalled();
    expect(fake.deleteByQuery).not.toHaveBeenCalled();
  });
  it("cleans up when indexing or retrieval fails", async () => {
    const fake = transport();
    fake.search.mockResolvedValue({ hits: { hits: [] } });
    await expect(runSmoke(env, fake.client)).rejects.toThrow("Smoke scoped retrieval or canonical revocation check failed");
    expect(fake.deleteByQuery).toHaveBeenCalledTimes(1);
    expect(fake.store.size).toBe(0);
    const failed = transport();
    failed.bulk.mockRejectedValue(new Error("es-secret"));
    await expect(runSmoke(env, failed.client)).rejects.toThrow("Smoke initial indexing failed");
    expect(failed.deleteByQuery).toHaveBeenCalledTimes(1);
  });
  it("reports an unavailable converse honestly while still cleaning up", async () => {
    const fake = transport();
    fake.fetcher.mockResolvedValue(new Response("kibana-secret", { status: 403 }));
    const result = await runSmoke(env, fake.client, { fetcher: fake.fetcher });
    expect(result.agent.mode).toBe("blocked");
    expect(result.agent.converseShape).toEqual({ status: 403, json: false });
    expect(result.cleanup).toBe("deleted 4 smoke documents");
    expect(sanitizeSummary(result, env)).not.toContain("kibana-secret");
  });
  it("redacts bound credentials and endpoints from summaries", () => {
    const output = sanitizeSummary({ message: `${env.ELASTICSEARCH_URL} ${env.KIBANA_URL} es-secret kibana-secret` }, env);
    expect(output).not.toContain("secret");
    expect(output).not.toContain(".invalid");
    expect(output).toContain("[REDACTED]");
  });
});
