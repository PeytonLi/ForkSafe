import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { outboxPool } from "./outbox.js";
import schema from "./schema.js";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("./**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\//, ""), load]),
);

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkpool(t, "outboxPool");
  return t;
}

describe("outbox requeue mutation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resets a dead entry and schedules dispatch while skipping delivered, unsupported, and missing entries", async () => {
    const t = createTest();
    const deadId = "11111111-1111-4111-8111-111111111111";
    const deliveredId = "22222222-2222-4222-8222-222222222222";
    const unsupportedId = "33333333-3333-4333-8333-333333333333";
    const missingId = "44444444-4444-4444-8444-444444444444";
    const deadRow = await t.run((ctx) => ctx.db.insert("outbox", {
      appId: deadId,
      destination: "elastic_index",
      status: "dead",
      idempotencyKey: "dead-row",
      operationId: "55555555-5555-4555-8555-555555555555",
      payload: { kind: "evaluation", id: "66666666-6666-4666-8666-666666666666" },
      attempts: 8,
      lastError: "invalid_tombstone",
      createdAtMs: 1,
      source: "spacetimedb",
      nextAttemptAtMs: 2,
    }));
    await t.run((ctx) => ctx.db.insert("outbox", {
      appId: deliveredId,
      destination: "jira_sync",
      status: "delivered",
      idempotencyKey: "delivered-row",
      operationId: "77777777-7777-4777-8777-777777777777",
      payload: {},
      attempts: 1,
      createdAtMs: 1,
      deliveredAtMs: 2,
      source: "spacetimedb",
      nextAttemptAtMs: 1,
    }));
    await t.run((ctx) => ctx.db.insert("outbox", {
      appId: unsupportedId,
      destination: "elastic_index",
      status: "pending",
      idempotencyKey: "not-implemented-row",
      operationId: "88888888-8888-4888-8888-888888888888",
      payload: {},
      attempts: 3,
      lastError: "not_implemented",
      createdAtMs: 1,
      source: "convex",
      nextAttemptAtMs: 2,
    }));
    const enqueue = vi.spyOn(outboxPool, "enqueueAction");

    await expect(t.mutation(internal.outbox.requeue, {
      receiptIds: [deadId, deliveredId, unsupportedId, missingId],
    })).resolves.toEqual({ requeued: 1, skipped: 3 });

    expect(enqueue).toHaveBeenCalledWith(expect.anything(), internal.outbox.dispatchOne, { receiptId: deadId });
    const row = await t.run((ctx) => ctx.db.get(deadRow));
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    expect(row).not.toHaveProperty("lastError");
    expect(row).not.toHaveProperty("deliveredAtMs");
    expect(row?.nextAttemptAtMs).toBeGreaterThan(2);
  });

  it("rejects more than 100 receipt IDs", async () => {
    const t = createTest();
    await expect(t.mutation(internal.outbox.requeue, {
      receiptIds: Array.from({ length: 101 }, (_, index) => `receipt-${index}`),
    })).rejects.toThrow("too_many_receipt_ids");
  });
});
