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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("experiment Elastic outbox", () => {
  it("enqueues committed experiments for indexing", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    registerWorkpool(t, "outboxPool");
    const enqueue = vi.spyOn(outboxPool, "enqueueAction")
      .mockImplementation(async () => undefined as never);
    const experimentId = crypto.randomUUID();

    await t.run(async (ctx) => {
      await ctx.db.insert("experiments", {
        appId: experimentId,
        investigationId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        epoch: 1,
        purpose: "evaluation",
        suite: "withheld",
        simCase: { caseId: "case-1", suite: "withheld", seed: 1, sceneOverrides: {} },
        status: "running",
        failureKinds: [],
        completed: false,
        changedFunctions: [],
        engineVersion: "pending",
        assetsSha256: "0".repeat(64),
        controllerSha256: "1".repeat(64),
        spacetimeCommitted: false,
        startedAtMs: Date.now(),
      });
    });

    await t.mutation(internal.evidence.finishExperiment, {
      experimentId,
      status: "succeeded",
      failureKinds: [],
      completed: true,
      engineVersion: "engine",
      assetsSha256: "a".repeat(64),
      controllerSha256: "1".repeat(64),
      spacetimeCommitted: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination: "elastic_index",
      idempotencyKey: `experiment_result:${experimentId}:elastic_index`,
      payload: { kind: "experiment_result", id: experimentId },
      source: "spacetimedb",
    });
    expect(enqueue).toHaveBeenCalled();
  });
});
