import { describe, expect, it } from "vitest";
import { toIngestEntries } from "./outboxIngest.js";

const op = "55555555-5555-4555-8555-555555555555";
const row = (patch: Record<string, unknown>) => ({
  idempotencyKey: "finding:abc:elastic_index", destination: "elastic_index", status: "pending", operationId: op,
  payloadJson: JSON.stringify({ kind: "finding", id: "abc" }), ...patch,
});

describe("SpacetimeDB outbox producer", () => {
  it("maps pending rows with the module's idempotency key and parsed payload", () => {
    expect(toIngestEntries([row({})])).toEqual({
      entries: [{ destination: "elastic_index", idempotencyKey: "finding:abc:elastic_index", operationId: op, payload: { kind: "finding", id: "abc" } }],
      skipped: 0,
    });
  });

  it("ignores delivered and dead rows and skips malformed ones without throwing", () => {
    const result = toIngestEntries([
      row({ status: "delivered" }), row({ status: "dead" }),
      row({ idempotencyKey: "k1-valid-key", payloadJson: "{not json" }),
      row({ idempotencyKey: "k2-valid-key", destination: "slack" }),
      row({ idempotencyKey: "short" }),
      row({ idempotencyKey: "k3-valid-key", payloadJson: "[1,2]" }),
    ]);
    expect(result).toEqual({ entries: [], skipped: 4 });
  });

  it("orders entries deterministically so batches are stable across ticks", () => {
    const keys = toIngestEntries([row({ idempotencyKey: "review:b:jira_sync", destination: "jira_sync" }), row({ idempotencyKey: "candidate:a:elastic_index" })])
      .entries.map((entry) => entry.idempotencyKey);
    expect(keys).toEqual(["candidate:a:elastic_index", "review:b:jira_sync"]);
  });
});
