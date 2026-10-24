import { describe, expect, it, vi } from "vitest";
import { deliverElasticPayload } from "./elastic.js";

const finding = {
  id: "11111111-1111-4111-8111-111111111111",
  investigationId: "22222222-2222-4222-8222-222222222222",
  environmentId: "33333333-3333-4333-8333-333333333333",
  kind: "behavioral_note",
  summary: "Observed contact",
  evidence: [],
  createdAtMs: 10,
};

function dependencies(overrides: Record<string, unknown> = {}) {
  const deps = {
    indexer: {
      index: vi.fn().mockResolvedValue([{ result: "created" }]),
      deleteBySource: vi.fn().mockResolvedValue(undefined),
    },
    spacetime: {
      getFinding: vi.fn().mockResolvedValue(finding),
      getExperiment: vi.fn(),
      getCandidate: vi.fn(),
      getEvaluation: vi.fn(),
      isTombstoned: vi.fn().mockResolvedValue(false),
      callReducer: vi.fn().mockResolvedValue(undefined),
    },
    mode: "live" as const,
    deadLetter: vi.fn().mockResolvedValue(true),
    wait: vi.fn().mockResolvedValue(undefined),
    random: () => 0,
    ...overrides,
  };
  return deps as unknown as Parameters<typeof deliverElasticPayload>[1];
}

describe("Elastic outbox delivery", () => {
  it("retries transient writes against the same canonical document and idempotency key", async () => {
    const deps = dependencies();
    const index = deps.indexer.index as ReturnType<typeof vi.fn>;
    index.mockRejectedValueOnce(new Error("response lost after write"));
    const result = await deliverElasticPayload({ kind: "finding", id: finding.id }, deps);

    expect(result).toEqual({ delivered: true, mode: "live" });
    expect(index).toHaveBeenCalledTimes(2);
    expect(index.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      `finding:${finding.id}:elastic_index`,
      `finding:${finding.id}:elastic_index`,
    ]);
    expect(deps.wait).toHaveBeenCalledTimes(1);
    expect(deps.spacetime.callReducer).toHaveBeenCalledWith("outbox_mark_delivered", {
      idempotencyKey: `finding:${finding.id}:elastic_index`,
    });
  });

  it("deletes projections and marks a tombstone delivered without indexing", async () => {
    const deps = dependencies();
    const result = await deliverElasticPayload({
      operation: "delete",
      targetKind: "finding",
      targetId: finding.id,
    }, deps);

    expect(result).toEqual({ delivered: true, mode: "live" });
    expect(deps.indexer.deleteBySource).toHaveBeenCalledWith({ sourceId: finding.id });
    expect(deps.indexer.index).not.toHaveBeenCalled();
    expect(deps.spacetime.callReducer).toHaveBeenCalledWith("outbox_mark_delivered", {
      idempotencyKey: `tombstone:finding:${finding.id}:elastic_index`,
    });
  });

  it("dead-letters permanent bulk failures by the canonical idempotency key", async () => {
    const deps = dependencies();
    (deps.indexer.index as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: "error", errorType: "permanent", status: 400, errorCode: "mapper_parsing_exception" },
    ]);

    expect(await deliverElasticPayload({ kind: "finding", id: finding.id }, deps)).toEqual({
      delivered: false,
      mode: "live",
      reason: "permanent:mapper_parsing_exception",
    });
    expect(deps.deadLetter).toHaveBeenCalledWith(
      `finding:${finding.id}:elastic_index`,
      "mapper_parsing_exception",
    );
  });

  it("keeps retrying transient/auth failures at most three times", async () => {
    const deps = dependencies();
    (deps.indexer.index as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: "error", errorType: "auth", status: 403 },
    ]);

    expect(await deliverElasticPayload({ kind: "finding", id: finding.id }, deps)).toEqual({
      delivered: false,
      mode: "live",
      reason: "elastic_transient",
    });
    expect(deps.indexer.index).toHaveBeenCalledTimes(3);
    expect(deps.deadLetter).not.toHaveBeenCalled();
  });

  it("dead-letters malformed full records without leaking record contents", async () => {
    const deps = dependencies();
    const result = await deliverElasticPayload({
      kind: "finding",
      record: { id: finding.id, private: "sensitive-record-value" },
    }, deps);

    expect(result).toEqual({
      delivered: false,
      mode: "live",
      reason: "permanent:elastic_invalid_payload",
    });
    expect(deps.deadLetter).toHaveBeenCalledWith(
      `finding:${finding.id}:elastic_index`,
      "elastic_invalid_payload",
    );
    expect(JSON.stringify(result)).not.toContain("sensitive-record-value");
  });
});
