import { describe, expect, it, vi } from "vitest";
import { SpacetimeClient, SpacetimeRejected, decodeSqlResponse } from "./spacetime.js";

const findingId = "11111111-1111-4111-8111-111111111111";
const investigationId = "22222222-2222-4222-8222-222222222222";
const uri = "https://spacetime.example.invalid";
const satsColumn = (name: string, type = "String") => ({
  name: { some: name },
  algebraic_type: { [type]: [] },
});

const findingTable = {
  schema: { elements: [
    satsColumn("id"), satsColumn("investigation_id"), satsColumn("environment_id"),
    satsColumn("session_id"), satsColumn("kind"), satsColumn("summary"), satsColumn("created_at_ms", "I64"),
  ] },
  rows: [[findingId, investigationId, findingId, { some: findingId }, "behavioral_note", "collision", "1700000000000"]],
};
const evidenceTable = {
  schema: { elements: [
    satsColumn("finding_id"), satsColumn("ordinal", "U32"), satsColumn("kind"),
    satsColumn("artifact_id"), satsColumn("experiment_id"), satsColumn("locator_json"), satsColumn("excerpt"),
  ] },
  rows: [
    [findingId, 2, "metric", { none: null }, { none: null }, "{\"frame\":2}", { none: null }],
    [findingId, 0, "log_excerpt", { some: findingId }, { none: null }, "{\"frame\":0}", { some: "first" }],
  ],
};
const capturedTombstoneSqlResponse = [{
  schema: { elements: [
    satsColumn("key"), satsColumn("target_kind"), satsColumn("target_id"),
    satsColumn("reason"), satsColumn("created_at_ms", "I64"),
  ] },
  rows: [["finding:11111111-1111-4111-8111-111111111111", "finding", findingId, "wire fixture", 1792837411311]],
  total_duration_micros: 138,
  stats: { rows_inserted: 0, rows_deleted: 0, rows_updated: 0 },
}];
const capturedReducerResponses = {
  registerBridge: { status: 200, body: "" },
  recordTombstone: { status: 200, body: "" },
  missingOutboxEntry: { status: 530, body: "outbox_missing: Outbox entry does not exist" },
};

describe("SpacetimeDB HTTP bridge", () => {
  it("decodes SATS JSON options and i64 values into row objects", () => {
    expect(decodeSqlResponse([findingTable])).toEqual([{
      id: findingId,
      investigationId,
      environmentId: findingId,
      sessionId: findingId,
      kind: "behavioral_note",
      summary: "collision",
      createdAtMs: 1700000000000,
    }]);
  });

  it("decodes the captured SpacetimeDB SQL wire response", () => {
    expect(decodeSqlResponse(capturedTombstoneSqlResponse)).toEqual([{
      key: `finding:${findingId}`,
      targetKind: "finding",
      targetId: findingId,
      reason: "wire fixture",
      createdAtMs: 1792837411311,
    }]);
  });

  it("classifies the captured reducer rejection body as a permanent code", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/call/register_bridge")) {
        return new Response(capturedReducerResponses.registerBridge.body, {
          status: capturedReducerResponses.registerBridge.status,
        });
      }
      return new Response(capturedReducerResponses.missingOutboxEntry.body, {
        status: capturedReducerResponses.missingOutboxEntry.status,
      });
    });
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: uri,
      SPACETIMEDB_DATABASE: "captured-wire-test",
      SPACETIMEDB_BRIDGE_TOKEN: "wire-token",
      FORKSAFE_BRIDGE_SECRET: "wire-secret",
    }, fetcher);

    await expect(client.callReducer("outbox_mark_delivered", { idempotencyKey: "missing:wire" }))
      .rejects.toMatchObject({ name: "SpacetimeRejected", code: "outbox_missing" });
    expect(capturedReducerResponses.recordTombstone).toMatchObject({ status: 200, body: "" });
  });

  it("uses identity registration once, bearer-authenticated SQL, and evidence ordinal ordering", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/identity")) {
        return Response.json({ identity: "identity", token: "private-token" });
      }
      if (url.endsWith("/call/register_bridge")) return Response.json({});
      return Response.json([url.endsWith("/sql") && String(init.body).includes("evidence") ? evidenceTable : findingTable]);
    });
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: uri,
      SPACETIMEDB_DATABASE: `bridge-test-${crypto.randomUUID()}`,
      FORKSAFE_BRIDGE_SECRET: "private-secret",
    }, fetcher);

    const result = await client.getFinding(findingId);

    expect(result?.evidence.map((evidence) => evidence.kind)).toEqual(["log_excerpt", "metric"]);
    expect(requests[0]?.url).toBe(`${uri}/v1/identity`);
    expect(requests[1]?.url).toContain("/call/register_bridge");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ secret: "private-secret" });
    expect(requests.slice(2).every(({ init }) => new Headers(init.headers).get("Authorization") === "Bearer private-token")).toBe(true);
    expect(requests.slice(2).every(({ init }) => init.method === "POST")).toBe(true);
    expect(requests.filter(({ url }) => url.endsWith("/sql")).map(({ init }) => init.body))
      .toContain(`SELECT * FROM evidence WHERE finding_id = '${findingId}'`);
  });

  it("uses a configured token without requesting identity and redacts rejection details", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/call/register_bridge")) return Response.json({});
      return Response.json({ error: { message: "SenderError: duplicate_id: private-secret private-token" } }, { status: 400 });
    });
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: `${uri}/`,
      SPACETIMEDB_DATABASE: `reducer-test-${crypto.randomUUID()}`,
      SPACETIMEDB_BRIDGE_TOKEN: "private-token",
      FORKSAFE_BRIDGE_SECRET: "private-secret",
    }, fetcher);

    let rejection: unknown;
    try {
      await client.callReducer("record_review", { id: findingId });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ name: "SpacetimeRejected", code: "duplicate_id" });
    expect((rejection as Error).message).not.toContain("private-secret");
    expect((rejection as Error).message).not.toContain("private-token");
    expect(requests[0]?.url).not.toContain("/v1/identity");
    expect(fetcher.mock.results.map((item) => String(item.value)).join(" ")).not.toContain("private-token");
  });

  it("rejects unsafe identifiers before issuing SQL", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: uri,
      SPACETIMEDB_DATABASE: "safe-test",
      SPACETIMEDB_BRIDGE_TOKEN: "safe-token",
      FORKSAFE_BRIDGE_SECRET: "safe-secret",
    }, fetcher);

    await expect(client.getFinding(`${findingId}' OR 1=1 --`)).rejects.toBeInstanceOf(SpacetimeRejected);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends SQL text and reducer JSON to the documented endpoints", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return String(input).endsWith("/call/register_bridge") || String(input).endsWith("/call/outbox_mark_delivered")
        ? Response.json({})
        : Response.json([]);
    });
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: uri,
      SPACETIMEDB_DATABASE: "wire-test",
      SPACETIMEDB_BRIDGE_TOKEN: "wire-token",
      FORKSAFE_BRIDGE_SECRET: "wire-secret",
    }, fetcher);
    await client.sql("SELECT * FROM finding");
    await client.callReducer("outbox_mark_delivered", { idempotencyKey: "finding:x:elastic_index" });

    expect(calls.find((call) => call.url.endsWith("/sql"))?.init).toMatchObject({
      method: "POST",
      body: "SELECT * FROM finding",
    });
    expect(calls.find((call) => call.url.endsWith("/sql"))?.url).toContain("/v1/database/wire-test/sql");
    expect(calls.find((call) => call.url.endsWith("/call/outbox_mark_delivered"))?.init.body)
      .toBe(JSON.stringify({ idempotencyKey: "finding:x:elastic_index" }));
    const headers = new Headers(calls.find((call) => call.url.endsWith("/sql"))?.init.headers);
    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("authorization")).toBe("Bearer wire-token");
  });
});
