import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema.js";
import { internal } from "../_generated/api.js";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("../**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\.\//, ""), load]),
);
modules["dispatchers/elastic.ts"] = () => import("./elastic.js");
modules["dispatchers/outbox.ts"] = () => import("./outbox.js");

describe("Elastic outbox dead-letter mutation", () => {
  it("marks only pending matching receipts dead and records a safe error code", async () => {
    const t = convexTest(schema, modules);
    const key = "finding:11111111-1111-4111-8111-111111111111:elastic_index";
    const pending = await t.run((ctx) => ctx.db.insert("outbox", {
      appId: "11111111-1111-4111-8111-111111111111",
      destination: "elastic_index",
      status: "pending",
      idempotencyKey: key,
      operationId: "22222222-2222-4222-8222-222222222222",
      payload: { kind: "finding", id: "11111111-1111-4111-8111-111111111111" },
      attempts: 0,
      createdAtMs: 1,
      source: "spacetimedb",
      nextAttemptAtMs: 1,
    }));
    const delivered = await t.run((ctx) => ctx.db.insert("outbox", {
      appId: "33333333-3333-4333-8333-333333333333",
      destination: "elastic_index",
      status: "delivered",
      idempotencyKey: "already-delivered",
      operationId: "44444444-4444-4444-8444-444444444444",
      payload: {},
      attempts: 1,
      createdAtMs: 1,
      deliveredAtMs: 2,
      source: "convex",
      nextAttemptAtMs: 1,
    }));

    expect(await t.mutation(internal.dispatchers.outbox.deadLetter, {
      idempotencyKey: key,
      errorCode: "mapper_parsing_exception",
    })).toEqual({ updated: true });
    expect(await t.mutation(internal.dispatchers.outbox.deadLetter, {
      idempotencyKey: "already-delivered",
      errorCode: "must_not_replace",
    })).toEqual({ updated: false });
    expect(await t.mutation(internal.dispatchers.outbox.deadLetter, {
      idempotencyKey: "missing",
      errorCode: "not_found",
    })).toEqual({ updated: false });

    const rows = await t.run(async (ctx) => ({
      pending: await ctx.db.get(pending),
      delivered: await ctx.db.get(delivered),
    }));
    expect(rows.pending).toMatchObject({ status: "dead", lastError: "mapper_parsing_exception" });
    expect(rows.delivered).toMatchObject({ status: "delivered" });
    expect(rows.delivered).not.toHaveProperty("lastError");
  });
});
