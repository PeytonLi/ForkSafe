import { describe, expect, it } from "vitest";
import { elasticIdempotencyKey } from "./elastic.js";
import { jiraIdempotencyKey } from "./jira.js";

describe("dispatcher dead-letter keys", () => {
  it("matches the idempotency keys passed to enqueueFor by SpacetimeDB", () => {
    // Mirrors the enqueueFor key templates in packages/spacetimedb/src/index.ts.
    const findingId = "11111111-1111-4111-8111-111111111111";
    const candidateId = "22222222-2222-4222-8222-222222222222";
    const evaluationId = "33333333-3333-4333-8333-333333333333";
    const reviewId = "44444444-4444-4444-8444-444444444444";
    const tombstoneId = "55555555-5555-4555-8555-555555555555";

    expect(elasticIdempotencyKey({ kind: "finding", id: findingId }))
      .toBe(`finding:${findingId}:elastic_index`);
    expect(elasticIdempotencyKey({ kind: "candidate", id: candidateId }))
      .toBe(`candidate:${candidateId}:elastic_index`);
    expect(elasticIdempotencyKey({ kind: "evaluation", id: evaluationId }))
      .toBe(`evaluation:${evaluationId}:elastic_index`);
    expect(jiraIdempotencyKey({ kind: "review", id: reviewId }))
      .toBe(`review:${reviewId}:jira_sync`);
    expect(elasticIdempotencyKey({
      operation: "delete",
      targetKind: "finding",
      targetId: tombstoneId,
    })).toBe(`tombstone:finding:${tombstoneId}:elastic_index`);
  });
});
