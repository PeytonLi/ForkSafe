import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("./**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\//, ""), load]),
);

describe("web pipeline health", () => {
  it("counts failed evidence commits and dead outbox entries", async () => {
    const t = convexTest(schema, modules);
    const id = () => crypto.randomUUID();
    await t.run(async (ctx) => {
      await ctx.db.insert("evaluations", {
        appId: id(),
        candidateId: id(),
        investigationId: id(),
        evaluatorAttemptId: id(),
        epoch: 1,
        suite: "withheld",
        cases: [],
        allRequiredPassed: false,
        status: "failed",
        spacetimeCommitted: false,
        commitStatus: "commit_failed",
        commitError: "grant_revoked",
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      await ctx.db.insert("outbox", {
        appId: id(),
        destination: "elastic_index",
        status: "dead",
        idempotencyKey: "dead-evaluation-index",
        operationId: id(),
        payload: { kind: "evaluation", id: id() },
        attempts: 8,
        createdAtMs: 1,
        source: "spacetimedb",
        nextAttemptAtMs: 1,
      });
    });

    await expect(t.query(api.web.health.pipeline, {})).resolves.toEqual({
      deadRows: { total: 2, evaluations: 1, outbox: 1 },
    });
  });
});
