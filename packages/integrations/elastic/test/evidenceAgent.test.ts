import { describe, expect, it, vi } from "vitest";
import { EnvConfig } from "@forksafe/contracts";
import { AgentConfigConflictError, FORKSAFE_AGENT, FORKSAFE_AGENT_ID, FORKSAFE_TOOLS, ForkSafeEvidenceAgent, KibanaClient, KibanaError,
  NOT_ENOUGH_EVIDENCE, parseAgentCitations, type CanonicalRecord, type CanonicalResolver } from "../src/index.ts";

const scope = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const key = ["kib", "ana", "-k3y"].join("");
const env = (overrides = {}) => EnvConfig.parse({ ELASTIC_MODE: "fixture", ELASTIC_AGENT_BUILDER_MODE: "cloud",
  KIBANA_URL: "https://kibana.invalid", KIBANA_API_KEY: key, ...overrides });
const ref = (docType: string, id: string, sourceVersion = "v1", investigationId = scope) => ({ docType, id, investigationId, sourceVersion });
const block = (citations: unknown[]) => "```json\n" + JSON.stringify({ citations }) + "\n```";
const canonical = (overrides: Record<string, Partial<CanonicalRecord>> = {}): CanonicalResolver => ({
  resolve: async refs => new Map(refs.map(r => [r.id, { authorized: true, sourceVersion: "v1", record: { investigationId: scope, id: r.id }, ...overrides[r.id] }])),
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function converse(message: string, steps: unknown[] = [{ type: "tool_call", tool_id: "forksafe.investigation_records" }]) {
  return vi.fn<typeof fetch>().mockResolvedValue(json({ conversation_id: "c-1", steps, response: { message } }));
}

describe("parseAgentCitations", () => {
  it("reads fenced and bare citation blocks, dedupes, and counts malformed entries", () => {
    const parsed = parseAgentCitations(`Contact at frame 3.\n${block([ref("finding", "f"), ref("finding", "f"), { id: "x" }, ref("evidence", "f:0")])}`);
    expect(parsed.refs.map(r => r.id)).toEqual(["f", "f:0"]);
    expect(parsed.malformed).toBe(1);
    expect(parsed.prose).toBe("Contact at frame 3.");
    expect(parseAgentCitations(`Answer {"citations":[${JSON.stringify(ref("finding", "g"))}]}`).refs).toHaveLength(1);
    expect(parseAgentCitations("```json\n{not json\n```").malformed).toBe(1);
    expect(parseAgentCitations("```json\n{\"sources\":[]}\n```").malformed).toBe(1);
  });
  it("detects the not-enough-evidence reply and rejects unknown docTypes", () => {
    expect(parseAgentCitations(`Not enough evidence.\n${block([])}`)).toMatchObject({ notEnoughEvidence: true, refs: [] });
    expect(parseAgentCitations(block([ref("review", "r")])).malformed).toBe(1);
  });
});

describe("ask", () => {
  it("validates input and scope before any network call", async () => {
    const fetcher = converse("x");
    const agent = new ForkSafeEvidenceAgent(env(), canonical(), { fetcher });
    await expect(agent.ask("", { investigationId: scope })).rejects.toThrow();
    await expect(agent.ask("q", { investigationId: "not-a-uuid" })).rejects.toThrow();
    await expect(agent.ask("q", { investigationId: scope, projectId: "x" } as never)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("calls converse on the stable agent with the scoped prompt and returns grounded prose when every citation re-checks", async () => {
    const fetcher = converse(`Forbidden contact at frame 3 [f].\n${block([ref("finding", "f"), ref("experiment_result", "e")])}`);
    const result = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher }).ask("Why did it fail?", { investigationId: scope });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://kibana.invalid/api/agent_builder/converse");
    expect(init?.headers).toMatchObject({ "kbn-xsrf": "true", Authorization: `ApiKey ${key}` });
    const body = JSON.parse(String(init?.body));
    expect(body.agent_id).toBe(FORKSAFE_AGENT_ID);
    expect(body.input).toContain(`investigationId: ${scope}`);
    expect(result).toMatchObject({ mode: "live", status: "grounded", answer: "Forbidden contact at frame 3 [f].", toolIds: ["forksafe.investigation_records"],
      conversationId: "c-1", usage: "evidence_only", scoreAffecting: false, droppedCitations: [] });
    expect(result.citations.map(c => c.id)).toEqual(["f", "e"]);
  });
  it("drops revoked, out-of-scope, stale and unresolved citations and withholds the prose", async () => {
    const fetcher = converse(`Secret claim.\n${block([ref("finding", "ok"), ref("evidence", "rev"), ref("finding", "x", "v1", other), ref("finding", "old", "v0"), ref("finding", "gone")])}`);
    const resolver: CanonicalResolver = { resolve: async refs => new Map(refs.filter(r => r.id !== "gone").map(r => [r.id, {
      authorized: true, revoked: r.id === "rev", sourceVersion: "v1", record: { investigationId: scope } }])) };
    const result = await new ForkSafeEvidenceAgent(env(), resolver, { fetcher }).ask("q", { investigationId: scope });
    expect(result.status).toBe("partially_grounded");
    expect(result.answer).not.toContain("Secret claim");
    expect(result.citations.map(c => c.id)).toEqual(["ok"]);
    expect(Object.fromEntries(result.droppedCitations.map(d => [d.id, d.reason]))).toEqual({ rev: "revoked", x: "out_of_scope", old: "stale", gone: "unresolved" });
  });
  it("rejects a citation whose canonical record lives in another investigation even if the agent claims our scope", async () => {
    const resolver: CanonicalResolver = { resolve: async refs => new Map(refs.map(r => [r.id, { authorized: true, sourceVersion: "v1", record: { investigationId: other } }])) };
    const result = await new ForkSafeEvidenceAgent(env(), resolver, { fetcher: converse(`Leak.\n${block([ref("finding", "f")])}`) }).ask("q", { investigationId: scope });
    expect(result).toMatchObject({ status: "withheld", citations: [], droppedCitations: [{ id: "f", reason: "out_of_scope" }] });
    expect(result.answer).not.toContain("Leak");
  });
  it("treats uncited prose and explicit refusals as not enough evidence", async () => {
    const uncited = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: converse("The robot is fine, trust me.") }).ask("q", { investigationId: scope });
    expect(uncited.status).toBe("not_enough_evidence");
    expect(uncited.answer).not.toContain("trust me");
    const refusal = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: converse(`${NOT_ENOUGH_EVIDENCE}\n${block([])}`) }).ask("q", { investigationId: scope });
    expect(refusal).toMatchObject({ status: "not_enough_evidence", answer: NOT_ENOUGH_EVIDENCE });
  });
  it("fails closed when the resolver throws", async () => {
    const resolver: CanonicalResolver = { resolve: async () => { throw new Error("db down"); } };
    const result = await new ForkSafeEvidenceAgent(env(), resolver, { fetcher: converse(`x\n${block([ref("finding", "f")])}`) }).ask("q", { investigationId: scope });
    expect(result).toMatchObject({ status: "withheld", citations: [], droppedCitations: [{ id: "f", reason: "resolver_unavailable" }] });
  });
  it("redacts credentials echoed in generated prose", async () => {
    const result = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: converse(`Key ${key} at https://kibana.invalid\n${block([ref("finding", "f")])}`) }).ask("q", { investigationId: scope });
    expect(result.answer).not.toContain(key);
    expect(result.answer).not.toContain("kibana.invalid");
  });
  it("reports blocked without network for missing credentials and sanitized reasons for HTTP/transport/shape errors", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await new ForkSafeEvidenceAgent(env({ KIBANA_API_KEY: undefined }), canonical(), { fetcher }).ask("q", { investigationId: scope }))
      .toMatchObject({ mode: "blocked", status: "unavailable" });
    expect(await new ForkSafeEvidenceAgent(env({ ELASTIC_AGENT_BUILDER_MODE: "disabled" }), canonical(), { fetcher }).ask("q", { investigationId: scope }))
      .toMatchObject({ mode: "not_implemented", status: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    const notFound = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: vi.fn<typeof fetch>().mockResolvedValue(json({ message: key }, 404)) }).ask("q", { investigationId: scope });
    expect(notFound.reason).toContain("run ensureAgent");
    const down = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error(`boom ${key}`)) }).ask("q", { investigationId: scope });
    const shape = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: vi.fn<typeof fetch>().mockResolvedValue(json({ response: {} })) }).ask("q", { investigationId: scope });
    for (const result of [notFound, down, shape]) {
      expect(result).toMatchObject({ mode: "blocked", status: "unavailable", citations: [] });
      expect(JSON.stringify(result)).not.toContain(key);
    }
  });
});

type Store = { tools: Map<string, Record<string, unknown>>; agents: Map<string, Record<string, unknown>> };
function kibana(store: Store = { tools: new Map(), agents: new Map() }, hooks: { failCreate?: (path: string) => boolean } = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${url.pathname}`);
    const [, , , kind, rawId] = url.pathname.split("/");
    const map = kind === "tools" ? store.tools : store.agents;
    const id = rawId ? decodeURIComponent(rawId) : body?.id;
    if (method === "GET") return map.has(id) ? json(map.get(id)) : json({ message: "not found" }, 404);
    if (method === "POST") {
      if (hooks.failCreate?.(url.pathname)) { map.set(id, { ...body, readonly: false }); return json({ message: "exists" }, 409); }
      map.set(id, { ...body, readonly: false }); return json(map.get(id));
    }
    if (method === "PUT") { map.set(id, { ...map.get(id), ...body }); return json(map.get(id)); }
    return json({}, 405);
  });
  return { fetcher, calls, store };
}

describe("ensureAgent", () => {
  it("creates tools and the agent once, then is a no-op", async () => {
    const fake = kibana();
    const agent = new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: fake.fetcher });
    const first = await agent.ensureAgent();
    expect(first.tools.map(t => t.action)).toEqual(FORKSAFE_TOOLS.map(() => "created"));
    expect(first.agent).toEqual({ id: FORKSAFE_AGENT_ID, action: "created" });
    const agentBody = fake.store.agents.get(FORKSAFE_AGENT_ID)!;
    expect(agentBody).toMatchObject({ configuration: { enable_elastic_capabilities: false, tools: [{ tool_ids: FORKSAFE_TOOLS.map(t => t.id) }] } });
    expect(String((agentBody.configuration as { instructions: string }).instructions)).toContain(NOT_ENOUGH_EVIDENCE);
    fake.calls.length = 0;
    const second = await agent.ensureAgent();
    expect([...second.tools.map(t => t.action), second.agent.action]).toEqual(Array(FORKSAFE_TOOLS.length + 1).fill("unchanged"));
    expect(fake.calls.every(call => call.startsWith("GET"))).toBe(true);
  });
  it("scopes index-search tools to the three ForkSafe evidence indices and the ES|QL tool to one investigation", () => {
    expect(FORKSAFE_TOOLS.filter(t => t.type === "index_search").map(t => t.configuration.pattern)).toEqual(["forksafe-findings", "forksafe-evidence", "forksafe-experiments"]);
    const esql = FORKSAFE_TOOLS.find(t => t.type === "esql")!;
    expect(esql.configuration.query).toContain("WHERE investigationId == ?investigationId");
  });
  it("converges drifted tools and agent with PUT, never DELETE", async () => {
    const fake = kibana();
    const agent = new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: fake.fetcher });
    await agent.ensureAgent();
    fake.store.tools.set("forksafe.search_findings", { ...fake.store.tools.get("forksafe.search_findings"), configuration: { pattern: "*" } });
    fake.store.agents.set(FORKSAFE_AGENT_ID, { ...fake.store.agents.get(FORKSAFE_AGENT_ID), configuration: { ...FORKSAFE_AGENT.configuration, instructions: "anything goes" } });
    fake.calls.length = 0;
    const result = await agent.ensureAgent();
    expect(result.tools.find(t => t.id === "forksafe.search_findings")?.action).toBe("updated");
    expect(result.agent.action).toBe("updated");
    expect(fake.store.tools.get("forksafe.search_findings")?.configuration).toEqual({ pattern: "forksafe-findings" });
    expect(fake.calls.some(call => call.startsWith("DELETE"))).toBe(false);
    expect(fake.calls.filter(call => call.startsWith("PUT"))).toEqual([`PUT /api/agent_builder/tools/forksafe.search_findings`, `PUT /api/agent_builder/agents/${FORKSAFE_AGENT_ID}`]);
  });
  it("converges after a concurrent create race instead of failing", async () => {
    const fake = kibana(undefined, { failCreate: path => path.endsWith("/tools") });
    const result = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: fake.fetcher }).ensureAgent();
    expect(result.tools.every(t => t.action === "unchanged")).toBe(true);
  });
  it("refuses to overwrite a same-id tool of another type and fails closed without credentials", async () => {
    const store: Store = { tools: new Map([["forksafe.search_findings", { id: "forksafe.search_findings", type: "esql", configuration: {} }]]), agents: new Map() };
    await expect(new ForkSafeEvidenceAgent(env(), canonical(), { fetcher: kibana(store).fetcher }).ensureAgent()).rejects.toBeInstanceOf(AgentConfigConflictError);
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ForkSafeEvidenceAgent(env({ KIBANA_URL: undefined }), canonical(), { fetcher }).ensureAgent()).rejects.toBeInstanceOf(KibanaError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("surfaces auth failures as typed errors without the key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ message: `bad ${key}` }, 401));
    const error = await new ForkSafeEvidenceAgent(env(), canonical(), { fetcher }).ensureAgent().catch(e => e);
    expect(error).toBeInstanceOf(KibanaError);
    expect(error.code).toBe("auth");
    expect(error.message).not.toContain(key);
  });
});

describe("KibanaClient", () => {
  it("rejects missing credentials, plain-http remote URLs and non-Agent-Builder paths", async () => {
    expect(() => new KibanaClient(undefined, key)).toThrow(KibanaError);
    expect(() => new KibanaClient("http://kibana.example.com", key)).toThrow("https");
    const client = new KibanaClient("https://kibana.invalid/", key, vi.fn<typeof fetch>());
    await expect(client.request("GET", "/api/security/role")).rejects.toThrow("Only Agent Builder");
  });
  it("maps timeouts and non-JSON bodies to typed errors", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    await expect(new KibanaClient("https://k.invalid", key, vi.fn<typeof fetch>().mockRejectedValue(timeout)).request("GET", "/api/agent_builder/agents"))
      .rejects.toMatchObject({ code: "timeout" });
    await expect(new KibanaClient("https://k.invalid", key, vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>"))).request("GET", "/api/agent_builder/agents"))
      .rejects.toMatchObject({ code: "invalid_response" });
  });
});
