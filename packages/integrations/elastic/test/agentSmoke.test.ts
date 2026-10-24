import { describe, expect, it, vi } from "vitest";
import { EnvConfig } from "@forksafe/contracts";
import { SYNTHETIC_PREFIX, SYNTHETIC_SOURCE, agentSmokeRecords, redactTranscript, runAgentSmoke, synthesize, type AgentSmokeClient } from "../src/agentSmoke.ts";
import { FORKSAFE_AGENT_ID, toDocuments } from "../src/index.ts";

const key = ["sm", "oke", "-k3y"].join("");
const env = EnvConfig.parse({ ELASTIC_MODE: "cloud", ELASTICSEARCH_URL: "https://es.invalid", ELASTICSEARCH_API_KEY: key,
  ELASTIC_AGENT_BUILDER_MODE: "cloud", KIBANA_URL: "https://kb.invalid", KIBANA_API_KEY: key });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeElastic(docs = new Map<string, Record<string, unknown>>(), opts: { bulkFails?: boolean } = {}) {
  const deleteByQuery = vi.fn(async ({ query }) => {
    const [ids, inv, src] = query.bool.filter;
    let deleted = 0;
    for (const [id, doc] of docs) if (ids.terms.id.includes(id) && doc.investigationId === inv.term.investigationId && doc.sourceSystem === src.term.sourceSystem) { docs.delete(id); deleted++; }
    return { deleted, failures: [] } as never;
  });
  const client: AgentSmokeClient = {
    bulk: vi.fn(async ({ operations }) => {
      const items = [];
      for (let i = 0; i < operations!.length; i += 2) {
        const op = (operations![i] as { index: { _id: string; _index: string } }).index;
        if (opts.bulkFails && op._index !== "forksafe-index-errors") { items.push({ index: { status: 400, error: { type: "mapper_parsing_exception" } } }); continue; }
        docs.set(op._id, operations![i + 1] as Record<string, unknown>);
        items.push({ index: { status: 201, result: "created" } });
      }
      return { errors: opts.bulkFails ?? false, items } as never;
    }),
    count: vi.fn(async ({ query }) => ({ count: query ? [...docs.values()].filter(d => d.investigationId === (query as { term: { investigationId: string } }).term.investigationId).length : docs.size }) as never),
    search: vi.fn(async ({ index }) => index === "forksafe-index-errors"
      ? { hits: { total: { value: 0 }, hits: [] } }
      : Array.isArray(index)
        ? { hits: { hits: [...docs.values()].filter(d => d.sourceSystem === SYNTHETIC_SOURCE).map(d => ({ _source: d, sort: [d.docType, d.id] })) } }
        : { hits: { hits: [] }, aggregations: { lastIndexedAt: { value: 1 } } }) as never,
    deleteByQuery,
    indices: { refresh: vi.fn(async () => ({})) },
  };
  return { client, docs, deleteByQuery };
}

function fakeKibana(citeAll: (records: Record<string, unknown>[]) => unknown[]) {
  const tools = new Map<string, unknown>(); const agents = new Map<string, unknown>();
  let records: Record<string, unknown>[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith("/converse")) {
      const cites = citeAll(records);
      return json({ conversation_id: "conv-1", steps: [{ type: "tool_call", tool_id: "forksafe.investigation_records" }],
        response: { message: `Forbidden contact. Key ${key}\n\`\`\`json\n${JSON.stringify({ citations: cites })}\n\`\`\`` } });
    }
    const [, , , kind, raw] = url.pathname.split("/"); const map = kind === "tools" ? tools : agents; const id = raw ? decodeURIComponent(raw) : body.id;
    if (method === "GET") return map.has(id) ? json(map.get(id)) : json({}, 404);
    map.set(id, { ...(map.get(id) as object), ...body, readonly: false }); return json(map.get(id));
  });
  return { fetcher, setRecords: (r: Record<string, unknown>[]) => { records = r; }, agents };
}

describe("synthetic smoke records", () => {
  it("are clearly synthetic: prefixed ids, synthetic source, marked text, fresh hashes", () => {
    const { projections, investigationId } = agentSmokeRecords(5);
    expect(projections.map(p => p.body.docType)).toEqual(["finding", "evidence", "experiment_result"]);
    for (const p of projections) {
      expect(p.id.startsWith(SYNTHETIC_PREFIX)).toBe(true);
      expect(p.body).toMatchObject({ sourceSystem: SYNTHETIC_SOURCE, investigationId });
      expect(p.body.text.startsWith("[SYNTHETIC]")).toBe(true);
      expect(p.body.idempotencyKey).toContain(p.body.contentHash);
    }
    expect(projections[1]!.body.findingId).toBe(projections[0]!.id);
    const original = toDocuments(agentSmokeRecords(5).finding, { now: 5 })[0]!;
    expect(synthesize(original).body.contentHash).not.toBe(original.body.contentHash);
    expect(agentSmokeRecords().investigationId).not.toBe(investigationId);
  });
});

describe("runAgentSmoke", () => {
  const cite = (docs: Record<string, unknown>[]) => docs.map(d => ({ docType: d.docType, id: d.id, investigationId: d.investigationId, sourceVersion: d.sourceVersion }));
  it("indexes, converges the agent, drops the revoked citation, redacts output and cleans up", async () => {
    const es = fakeElastic();
    const kb = fakeKibana(() => cite([...es.docs.values()]));
    const result = await runAgentSmoke(env, es.client, { fetcher: kb.fetcher, now: 100 });
    expect(result.ok).toBe(true);
    expect(result.ensure.first.agent).toEqual({ id: FORKSAFE_AGENT_ID, action: "created" });
    expect(result.ensure.second.agent.action).toBe("unchanged");
    expect(result.recheck).toMatchObject({ revokedCitedByAgent: true, revokedDropped: true, revokedNeverAccepted: true });
    expect(result.transcript.citations).toHaveLength(2);
    expect(result.transcript.answer).not.toContain(key);
    expect(result.reconcile.inSync).toBe(true);
    expect(es.docs.size).toBe(0);
    expect(result.cleanup).toBe("deleted 3 synthetic documents; 0 remaining for the investigation");
    expect(redactTranscript({ k: key, u: "https://es.invalid/x", h: "ApiKey abc123" }, env)).not.toMatch(/smoke-k3y|es\.invalid|abc123/);
  });
  it("is not ok when the agent cites nothing, and never deletes non-synthetic docs", async () => {
    const real = { id: "real-1", investigationId: "x", sourceSystem: "convex", docType: "finding" };
    const es = fakeElastic(new Map([["real-1", real]]));
    const result = await runAgentSmoke(env, es.client, { fetcher: fakeKibana(() => []).fetcher, now: 100 });
    expect(result).toMatchObject({ ok: false, transcript: { status: "not_enough_evidence" } });
    expect([...es.docs.keys()]).toEqual(["real-1"]);
  });
  it("records indexing errors, still cleans up, and refuses non-cloud modes", async () => {
    const es = fakeElastic(undefined, { bulkFails: true });
    await expect(runAgentSmoke(env, es.client, { fetcher: fakeKibana(() => []).fetcher })).rejects.toThrow("indexing failed");
    expect(es.deleteByQuery).toHaveBeenCalledTimes(1);
    expect([...es.docs.values()].every(d => "errorType" in d)).toBe(true);
    await expect(runAgentSmoke(EnvConfig.parse({ ELASTIC_MODE: "fixture" }), es.client)).rejects.toThrow("requires ELASTIC_MODE=cloud");
  });
});
