import { describe, expect, it, vi } from "vitest";
import { SpacetimeClient, SpacetimeRejected, decodeSqlResponse } from "./spacetime.js";
import { SpacetimeConfigError } from "../lib/spacetime.js";

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

describe("SpacetimeDB HTTP base", () => {
  it.each([
    { uri: "wss://spacetime.example.invalid", httpBase: "https://spacetime.example.invalid" },
    { uri: "ws://spacetime.example.invalid", httpBase: "http://spacetime.example.invalid" },
    { uri: "https://spacetime.example.invalid", httpBase: "https://spacetime.example.invalid" },
    { uri: "http://spacetime.example.invalid", httpBase: "http://spacetime.example.invalid" },
    { uri: "https://spacetime.example.invalid/base///", httpBase: "https://spacetime.example.invalid/base" },
  ])("uses the normalized base for $uri", async ({ uri: configuredUri, httpBase }) => {
    const database = `normalization-test-${crypto.randomUUID()}`;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: configuredUri,
      SPACETIMEDB_DATABASE: database,
      SPACETIMEDB_BRIDGE_TOKEN: "wire-token",
      FORKSAFE_BRIDGE_SECRET: "wire-secret",
    }, fetcher);

    await expect(client.sql("SELECT 1")).resolves.toEqual([]);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      `${httpBase}/v1/database/${database}/call/register_bridge`,
      `${httpBase}/v1/database/${database}/sql`,
    ]);
  });

  it("rejects unsupported schemes as a typed configuration error", () => {
    const fetcher = vi.fn<typeof fetch>();

    expect(() => new SpacetimeClient({
      SPACETIMEDB_URI: "ftp://spacetime.example.invalid",
      SPACETIMEDB_DATABASE: "invalid-scheme-test",
    }, fetcher)).toThrow(SpacetimeConfigError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

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

  it("decodes Maincloud hash columns with numeric suffixes", () => {
    expect(decodeSqlResponse([{
      schema: { elements: [satsColumn("controller_sha_256")] },
      rows: [["a".repeat(64)]],
    }])).toEqual([{ controllerSha256: "a".repeat(64) }]);
  });

  it("decodes an empty Maincloud result set", () => {
    expect(decodeSqlResponse([{
      schema: { elements: [satsColumn("id")] },
      rows: [],
      total_duration_micros: 21,
    }])).toEqual([]);
  });

  it.each([
    "`investigation_id` is not in scope",
    "Aggregate expressions must have column aliases",
  ])("maps a plain-text Maincloud SQL error to a safe HTTP code: %s", async (body) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/call/register_bridge")) return new Response("", { status: 200 });
      return new Response(body, { status: 400 });
    });
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: uri,
      SPACETIMEDB_DATABASE: `plain-text-sql-error-test-${crypto.randomUUID()}`,
      SPACETIMEDB_BRIDGE_TOKEN: "wire-token",
      FORKSAFE_BRIDGE_SECRET: "wire-secret",
    }, fetcher);

    await expect(client.findingsCount(investigationId))
      .rejects.toMatchObject({ name: "SpacetimeRejected", code: "http_400" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("parses review rows using Maincloud's controller_sha_256 column", async () => {
    const reviewId = "44444444-4444-4444-8444-444444444444";
    const candidateId = "33333333-3333-4333-8333-333333333333";
    const evaluationId = "55555555-5555-4555-8555-555555555555";
    const controllerSha256 = "a".repeat(64);
    const reviewTable = {
      schema: { elements: [
        satsColumn("id"), satsColumn("investigation_id"), satsColumn("candidate_id"),
        satsColumn("evaluation_id"), satsColumn("controller_sha_256"), satsColumn("decision"),
        satsColumn("reviewer_identity"), satsColumn("notes"), satsColumn("jira_issue_key"),
        satsColumn("created_at_ms", "I64"),
      ] },
      rows: [[
        reviewId, investigationId, candidateId, evaluationId, controllerSha256, "approved",
        "forksafe:reviewer", { none: null }, { none: null }, "1792851276516",
      ]],
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/call/register_bridge")) return new Response("", { status: 200 });
      return Response.json([reviewTable]);
    });
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: uri,
      SPACETIMEDB_DATABASE: "review-wire-test",
      SPACETIMEDB_BRIDGE_TOKEN: "wire-token",
      FORKSAFE_BRIDGE_SECRET: "wire-secret",
    }, fetcher);

    await expect(client.getReview(reviewId)).resolves.toEqual({
      id: reviewId,
      investigationId,
      candidateId,
      evaluationId,
      controllerSha256,
      decision: "approved",
      reviewerIdentity: "forksafe:reviewer",
      createdAtMs: 1792851276516,
    });
  });

  it("fetches candidate rows using Maincloud's controller_sha_256 column", async () => {
    const candidateId = "33333333-3333-4333-8333-333333333333";
    const environmentId = "66666666-6666-4666-8666-666666666666";
    const sourceArtifactId = "77777777-7777-4777-8777-777777777777";
    const attemptId = "88888888-8888-4888-8888-888888888888";
    const grantId = "99999999-9999-4999-8999-999999999999";
    const controllerSha256 = "b".repeat(64);
    const candidateTable = {
      schema: { elements: [
        satsColumn("id"), satsColumn("investigation_id"), satsColumn("environment_id"),
        satsColumn("revision_id"), satsColumn("controller_sha_256"), satsColumn("source_artifact_id"),
        satsColumn("changed_functions"), satsColumn("rationale"), satsColumn("based_on_findings"),
        satsColumn("submitted_by_attempt_id"), satsColumn("grant_id"), satsColumn("epoch", "U32"),
        satsColumn("submitted_at_ms", "I64"),
      ] },
      rows: [[
        candidateId, investigationId, environmentId, { none: null }, controllerSha256,
        sourceArtifactId, ["drive"], { none: null }, [], attemptId, grantId, 1, "1792851276516",
      ]],
    };
    const evaluationTable = {
      schema: { elements: [satsColumn("id"), satsColumn("status")] },
      rows: [["55555555-5555-4555-8555-555555555555", "passed"]],
    };
    const emptyReviewTable = { schema: { elements: [satsColumn("decision")] }, rows: [] };
    const emptyTombstoneTable = { schema: { elements: [satsColumn("key")] }, rows: [] };
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/call/register_bridge")) return new Response("", { status: 200 });
      const query = String(init.body);
      if (query.includes("FROM candidate WHERE id")) return Response.json([candidateTable]);
      if (query.includes("FROM evaluation WHERE candidate_id")) return Response.json([evaluationTable]);
      if (query.includes("FROM human_review WHERE candidate_id")) return Response.json([emptyReviewTable]);
      if (query.includes("FROM tombstone")) return Response.json([emptyTombstoneTable]);
      throw new Error("unexpected SQL query");
    });
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: uri,
      SPACETIMEDB_DATABASE: "candidate-wire-test",
      SPACETIMEDB_BRIDGE_TOKEN: "wire-token",
      FORKSAFE_BRIDGE_SECRET: "wire-secret",
    }, fetcher);

    await expect(client.getCandidate(candidateId)).resolves.toEqual({
      id: candidateId,
      investigationId,
      environmentId,
      status: "evaluated",
      controllerSha256,
      sourceArtifactId,
      changedFunctions: ["drive"],
      basedOnFindings: [],
      submittedByAttemptId: attemptId,
      submittedAtMs: 1792851276516,
    });
  });

  it.each(["experiment_result", "evaluation"])("does not query tombstones for %s records", async (kind) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SpacetimeClient({
      SPACETIMEDB_URI: uri,
      SPACETIMEDB_DATABASE: "non-tombstone-test",
      SPACETIMEDB_BRIDGE_TOKEN: "wire-token",
      FORKSAFE_BRIDGE_SECRET: "wire-secret",
    }, fetcher);

    await expect(client.isTombstoned(kind, findingId)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
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
