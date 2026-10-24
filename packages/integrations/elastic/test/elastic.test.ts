import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { EnvConfig, OutboxDestination } from "@forksafe/contracts";
import { Client, type estypes } from "@elastic/elasticsearch";
import { AgentBuilder, BlockedError, ElasticIndexer, ElasticSearch, agentBuilderReadiness, bootstrapIndices, canonicalJSON, createElasticClient, elasticReadiness, mapping, probeElastic, resolveConfig, toDocuments, type CanonicalResolver, type EvidenceDocument } from "../src/index.ts";

const id = "11111111-1111-4111-8111-111111111111";
const scope = "22222222-2222-4222-8222-222222222222";
const finding = { id, investigationId: scope, environmentId: id, kind: "behavioral_note", summary: "Repair collision",
  evidence: [{ kind: "log_excerpt", excerpt: "collision at frame 3", artifactId: id }], createdAtMs: 100 };
const experiment = { id, investigationId: scope, attemptId: id, epoch: 0, simCase: { caseId: "case-1", suite: "public", seed: 1 },
  status: "succeeded", completed: true, engineVersion: "3", assetsSha256: "a".repeat(64), controllerSha256: "b".repeat(64), startedAtMs: 1 };
const env = (overrides = {}) => EnvConfig.parse({ ELASTIC_MODE: "fixture", ...overrides });
const docs = toDocuments(finding);
const resolver: CanonicalResolver = { resolve: async refs => new Map(refs.map(ref => [ref.id, {
  authorized: true, sourceVersion: ref.sourceVersion, record: { investigationId: ref.investigationId, summary: "Canonical collision" },
}])) };
const searchResponse = (bodies: EvidenceDocument[]) => ({ took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 },
  hits: { hits: bodies.map(body => ({ _index: "forksafe-findings", _id: body.id, _source: body, _score: 1 })) } });

describe("configuration", () => {
  it("reports missing names only without creating a client", () => {
    const input = env({ ELASTIC_MODE: "cloud", ELASTICSEARCH_API_KEY: "secret-value", ELASTIC_AGENT_BUILDER_MODE: "cloud" });
    expect(elasticReadiness(input, 5)).toEqual({ name: "elastic", mode: "blocked", detail: "Missing: ELASTICSEARCH_URL", checkedAtMs: 5 });
    expect(JSON.stringify(agentBuilderReadiness(input, 5))).toContain("KIBANA_API_KEY");
    expect(JSON.stringify(elasticReadiness(input, 5))).not.toContain("secret-value");
    expect(createElasticClient(input)).toBeUndefined();
  });
  it("defaults local URL, permits local without auth, and handles fixture/disabled", async () => {
    const input = env({ ELASTIC_MODE: "local" });
    expect(resolveConfig(input).ELASTICSEARCH_URL).toBe("http://127.0.0.1:9200");
    expect(elasticReadiness(input, 1).mode).toBe("local");
    const client = createElasticClient(input)!;
    expect(client).toBeInstanceOf(Client);
    await client.close();
    expect(elasticReadiness(env(), 0).mode).toBe("fixture");
    expect(elasticReadiness(env({ ELASTIC_MODE: "disabled" }), 0).mode).toBe("not_implemented");
    expect(createElasticClient(env())).toBeUndefined();
    expect(await probeElastic({ ping: async () => { throw new Error("secret"); } })).toEqual({ mode: "blocked", reason: "Elastic probe failed" });
    expect(await probeElastic({ ping: async () => true })).toEqual({ mode: "live" });
  });
});
describe("mappings and indexing", () => {
  it("runs the documented native TypeScript bootstrap without loading contracts JS imports", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/bin/bootstrap.ts"], {
      encoding: "utf8", env: { PATH: process.env.PATH, ELASTIC_MODE: "disabled" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Elastic bootstrap unavailable: select a configured cloud or local mode");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });
  it("maps every metadata field strictly", () => {
    expect(mapping.dynamic).toBe("strict");
    for (const key of ["docType", "kind", "investigationId", "environmentId", "sessionId", "candidateId", "experimentId", "artifactId", "findingId", "failureKinds", "status", "suite", "caseId", "idempotencyKey", "sourceVersion", "sourceSystem", "sourceEntity", "sourceId"]) expect(mapping.properties?.[key]).toEqual({ type: "keyword" });
    expect(mapping.properties?.createdAt).toEqual({ type: "date", format: "epoch_millis" });
    expect(mapping.properties?.indexedAt).toEqual({ type: "date", format: "epoch_millis" });
    expect(mapping.properties?.text).toMatchObject({ type: "text" });
    for (const doc of docs) for (const key of Object.keys(doc.body)) expect(mapping.properties).toHaveProperty(key);
  });
  it("bootstraps missing indices and tolerates create races only", async () => {
    const create = vi.fn().mockRejectedValueOnce({ meta: { body: { error: { type: "resource_already_exists_exception" } } } }).mockResolvedValue({});
    await bootstrapIndices({ indices: { exists: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false), create } });
    expect(create).toHaveBeenCalledTimes(2);
    await expect(bootstrapIndices({ indices: { exists: async () => false, create: async () => { throw new Error("secret"); } } })).rejects.toThrow("Elastic index bootstrap failed");
  });
  it("builds deterministic finding, evidence and experiment IDs and bodies", () => {
    expect(toDocuments(finding)).toEqual(docs);
    expect(docs.map(d => d.id)).toEqual([id, `${id}:0`]);
    expect(docs[0]?.body.indexedAt).toBe(100);
    expect(toDocuments({ ...finding, evidence: [] })).toHaveLength(1);
    expect(toDocuments(experiment)[0]).toMatchObject({ id, index: "forksafe-experiments", body: { docType: "experiment_result", suite: "public", caseId: "case-1" } });
    expect(() => toDocuments({})).toThrow();
    expect(canonicalJSON({ b: 2, a: 1 })).toBe(canonicalJSON({ a: 1, b: 2 }));
    expect(toDocuments(finding, { now: 7, idempotencyKey: "outbox-key" })[0]?.body).toMatchObject({ indexedAt: 7, idempotencyKey: "outbox-key" });
  });
  it("fixture redelivery is a noop with identical bodies", async () => {
    const indexer = new ElasticIndexer("fixture");
    expect((await indexer.index(finding)).map(r => r.result)).toEqual(["created", "created"]);
    const before = [...indexer.store.values()];
    expect((await indexer.index(finding)).map(r => r.result)).toEqual(["noop", "noop"]);
    expect([...indexer.store.values()]).toEqual(before);
  });
  it("sends explicit bulk index IDs and stable bodies on repeated delivery", async () => {
    const bulk = vi.fn().mockImplementation(async () => ({ items: docs.map(() => ({ index: { status: 200, result: "updated" } })) }));
    const indexer = new ElasticIndexer("live", { bulk });
    await indexer.index(finding, { refresh: "wait_for" });
    expect((await indexer.index(finding, { refresh: "wait_for" }))[0]?.result).toBe("updated");
    expect(bulk.mock.calls[0]).toEqual(bulk.mock.calls[1]);
    expect(bulk.mock.calls[0]?.[0]).toEqual({ refresh: "wait_for", operations: docs.flatMap(d => [{ index: { _index: d.index, _id: d.id } }, d.body]) });
  });
  it("handles bulk item and transport failures without secret messages", async () => {
    const bulk = vi.fn().mockResolvedValue({ items: [{ index: { status: 400, error: { reason: "secret" } } }] });
    expect((await new ElasticIndexer("live", { bulk }).index(finding)).every(r => r.result === "error")).toBe(true);
    bulk.mockRejectedValue(new Error("secret"));
    expect(JSON.stringify(await new ElasticIndexer("live", { bulk }).index(finding))).not.toContain("secret");
    await expect(new ElasticIndexer("blocked", { bulk }).index(finding)).rejects.toBeInstanceOf(BlockedError);
    expect(bulk).toHaveBeenCalledTimes(2);
  });
  it("uses the actual contracts outbox destination and key", async () => {
    expect(OutboxDestination.options).toEqual(["elastic_index", "jira_sync", "confluence_link"]);
    const indexer = new ElasticIndexer("fixture");
    const entry = { id, destination: "elastic_index" as const, status: "pending" as const, operationId: id,
      idempotencyKey: "outbox-key", payload: { kind: "finding", record: finding }, attempts: 0, createdAtMs: 5 };
    await indexer.indexOutboxEntry(entry);
    expect([...indexer.store.values()][0]?.body).toMatchObject({ idempotencyKey: "outbox-key", indexedAt: 5 });
    await expect(indexer.indexOutboxEntry({ ...entry, destination: "jira_sync" })).rejects.toThrow("Unsupported outbox destination");
    await expect(indexer.indexOutboxEntry({ ...entry, payload: { kind: "other" } })).rejects.toThrow("Unsupported elastic payload kind");
  });
});
describe("search authorization", () => {
  it("always includes investigation term filter with metadata filters and text search", async () => {
    const search = vi.fn().mockResolvedValue(searchResponse(docs.map(d => d.body)));
    const result = await new ElasticSearch("live", resolver, { search }).searchEvidence({ query: "collision", investigationId: scope, environmentId: id, docTypes: ["evidence"], kinds: ["log_excerpt"], failureKinds: ["timeout"] });
    expect(search.mock.calls[0]?.[0].query.bool.filter).toEqual([{ term: { investigationId: scope } }, { term: { environmentId: id } }, { terms: { docType: ["evidence"] } }, { terms: { failureKinds: ["timeout"] } }, { terms: { kind: ["log_excerpt"] } }]);
    expect(search.mock.calls[0]?.[0].query.bool.must).toEqual([{ multi_match: { query: "collision", fields: ["text"] } }]);
    expect(result.hits).toHaveLength(2);
    expect(result.usage).toBe("evidence_only");
  });
  it.each(["revoked", "unauthorized", "stale", "out_of_scope", "deleted", "superseded", "unresolved"])("drops %s canonical hits", async reason => {
    const r: CanonicalResolver = { resolve: async refs => new Map(reason === "unresolved" ? [] : refs.map(ref => [ref.id, {
      authorized: reason !== "unauthorized", revoked: reason === "revoked", deleted: reason === "deleted", superseded: reason === "superseded",
      sourceVersion: reason === "stale" ? "old" : ref.sourceVersion, record: { investigationId: reason === "out_of_scope" ? id : scope },
    }])) };
    const result = await new ElasticSearch("fixture", r, undefined, docs).searchEvidence({ query: "", investigationId: scope });
    expect(result.hits).toEqual([]);
    expect(result.dropped.map(d => d.reason)).toEqual([reason, reason]);
  });
  it("does not trust the index's scope even if the backend returns it", async () => {
    const search = vi.fn().mockResolvedValue(searchResponse([{ ...docs[0]!.body, investigationId: id }]));
    const result = await new ElasticSearch("live", resolver, { search }).searchEvidence({ query: "", investigationId: scope });
    expect(result.dropped).toEqual([{ id, reason: "out_of_scope" }]);
  });
  it("is deterministic in fixture mode, handles empty and resolver error cases", async () => {
    const search = new ElasticSearch("fixture", resolver, undefined, [...docs].reverse().values());
    const input = { query: "collision", investigationId: scope };
    const first = await search.searchEvidence(input);
    expect(await search.searchEvidence(input)).toEqual(first);
    expect(first.hits.every(h => h.mode === "fixture")).toBe(true);
    expect((await search.searchEvidence({ ...input, query: "absent" })).hits).toEqual([]);
    const failed = new ElasticSearch("fixture", { resolve: async () => { throw new Error("secret"); } }, undefined, docs);
    expect((await failed.searchEvidence(input)).dropped[0]?.reason).toBe("resolver_unavailable");
    await expect(search.searchEvidence({ ...input, investigationId: "" })).rejects.toThrow("investigationId is required");
  });
  it("blocked mode does not call transport and transport errors are sanitized", async () => {
    const search = vi.fn().mockRejectedValue(new Error("secret"));
    expect((await new ElasticSearch("blocked", resolver, { search }).searchEvidence({ query: "", investigationId: scope })).mode).toBe("blocked");
    expect(search).not.toHaveBeenCalled();
    const result = await new ElasticSearch("live", resolver, { search }).searchEvidence({ query: "", investigationId: scope });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.mode).toBe("blocked");
  });
});
describe("Agent Builder", () => {
  const cloud = env({ ELASTIC_AGENT_BUILDER_MODE: "cloud", KIBANA_URL: "https://kibana.test/", KIBANA_API_KEY: "private-key" });
  const fixtureSearch = () => new ElasticSearch("fixture", resolver, undefined, docs);
  it("uses the documented converse shape and only one read-only endpoint", async () => {
    const citation = { docType: "finding", id, investigationId: scope, sourceVersion: docs[0]!.body.sourceVersion };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ conversation_id: "conv", response: { message: "Collision found" }, steps: [{ citations: [citation] }] })));
    const result = await new AgentBuilder(cloud, resolver, fixtureSearch(), fetcher).ask({ input: "why?", investigationId: scope, agentId: "read-only-agent", conversationId: "conv" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://kibana.test/api/agent_builder/converse");
    const request = fetcher.mock.calls[0]?.[1]!;
    expect(request.headers).toEqual({ Authorization: "ApiKey private-key", "kbn-xsrf": "true", "Content-Type": "application/json" });
    expect(request.method).toBe("POST");
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({ agent_id: "read-only-agent", conversation_id: "conv" });
    expect(body.input).toContain(scope);
    expect(body.input).toContain("forksafe-*");
    expect(body.input).toContain("Read-only");
    expect(result).toMatchObject({ mode: "live", answer: "Collision found", usage: "evidence_only", scoreAffecting: false, citations: [{ id }] });
  });
  it("drops invalid canonical citations and withholds tainted prose", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ response: { message: "secret claim" }, steps: [{ docType: "finding", id, investigationId: scope, sourceVersion: "stale" }] })));
    const stale: CanonicalResolver = { resolve: async () => new Map([[id, { authorized: false, sourceVersion: "current", record: { investigationId: scope } }]]) };
    const result = await new AgentBuilder(cloud, stale, fixtureSearch(), fetcher).ask({ input: "why", investigationId: scope });
    expect(result.citations).toEqual([]);
    expect(result.droppedCitations).toEqual([{ id, reason: "unauthorized" }]);
    expect(result.answer).not.toContain("secret claim");
  });
  it("blocks missing credentials without network and sanitizes HTTP/transport errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private-key"));
    const question = { input: "why", investigationId: scope };
    expect((await new AgentBuilder(env({ ELASTIC_AGENT_BUILDER_MODE: "cloud" }), resolver, fixtureSearch(), fetcher).ask(question)).mode).toBe("blocked");
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(await new AgentBuilder(cloud, resolver, fixtureSearch(), fetcher).ask(question))).not.toContain("private-key");
    fetcher.mockResolvedValue(new Response("private-key", { status: 403 }));
    expect((await new AgentBuilder(cloud, resolver, fixtureSearch(), fetcher).ask(question)).mode).toBe("blocked");
  });
  it("uses deterministic labeled fallback for disabled and fixture modes", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const builder = new AgentBuilder(env(), resolver, fixtureSearch(), fetcher);
    const question = { input: "collision", investigationId: scope };
    const answer = await builder.ask(question);
    expect(answer).toEqual(await builder.ask(question));
    expect(answer).toMatchObject({ mode: "not_implemented", label: "Deterministic fallback — Agent Builder not used" });
    expect(answer.answer).toContain(id);
    expect((await builder.ask({ ...question, input: "absent" })).answer).toBe("No authorized matching evidence.");
    expect((await new AgentBuilder(env({ ELASTIC_AGENT_BUILDER_MODE: "fixture" }), resolver, fixtureSearch(), fetcher).ask(question)).mode).toBe("fixture");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// Structural compatibility with the real transport is checked without opening connections.
function realClientCompatibility(client: Client) {
  new ElasticIndexer("live", client);
  new ElasticSearch("live", resolver, client);
  const response: estypes.SearchResponse<EvidenceDocument> = searchResponse([]);
  return response;
}
void realClientCompatibility;
