import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("./**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\//, ""), load]),
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function addPendingEvaluation(t: any, revoked = false) {
  const now = Date.now();
  const ids = {
    evaluation: crypto.randomUUID(),
    grant: crypto.randomUUID(),
    attempt: crypto.randomUUID(),
    job: crypto.randomUUID(),
    candidate: crypto.randomUUID(),
    investigation: crypto.randomUUID(),
  };
  await t.run(async (ctx: any) => {
    await ctx.db.insert("attempts", {
      appId: ids.attempt,
      jobId: ids.job,
      epoch: 2,
      state: revoked ? "succeeded" : "heartbeating",
      workerId: "convex-evaluator",
      leasedUntilMs: now + 60_000,
      lastHeartbeatMs: now,
      startedAtMs: now - 1_000,
    });
    await ctx.db.insert("grants", {
      appId: ids.grant,
      jobId: ids.job,
      attemptId: ids.attempt,
      epoch: 2,
      investigationId: ids.investigation,
      scope: { operations: ["record_evaluation"], artifactPrefixes: [], maxBytes: 1_000 },
      expiresAtMs: now + 60_000,
      ...(revoked ? { revokedAtMs: now, revokeReason: "completed" } : {}),
      bridgeMode: "live",
      installedAtMs: now - 1_000,
      spacetimeInstalled: true,
      spacetimeRevoked: revoked,
      createdAtMs: now - 1_000,
    });
    await ctx.db.insert("evaluations", {
      appId: ids.evaluation,
      candidateId: ids.candidate,
      investigationId: ids.investigation,
      evaluatorAttemptId: ids.attempt,
      jobId: ids.job,
      epoch: 2,
      grantId: ids.grant,
      suite: "withheld",
      cases: [{ caseId: "case-1", status: "failed", failureKinds: ["contact_violation"] }],
      allRequiredPassed: false,
      status: "failed",
      spacetimeCommitted: false,
      commitStatus: "pending",
      createdAtMs: now - 500,
      updatedAtMs: now - 500,
    });
  });
  return ids;
}

describe("evaluation commit reconciliation", () => {
  it("retries a pending evaluation while its grant and attempt remain valid", async () => {
    for (const [name, value] of Object.entries({
      SPACETIMEDB_MODE: "cloud",
      SPACETIMEDB_URI: "https://spacetime.example.invalid",
      SPACETIMEDB_DATABASE: "forksafe",
      FORKSAFE_BRIDGE_SECRET: "bridge-secret",
      SPACETIMEDB_BRIDGE_TOKEN: "bridge-token",
    })) vi.stubEnv(name, value);
    const fetcher = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const t = convexTest(schema, modules);
    const ids = await addPendingEvaluation(t);

    await expect(t.action(internal.evaluationReconcile.reconcilePendingCommits, {}))
      .resolves.toEqual({ checked: 1, committed: 1, pending: 0, failed: 0, notApplicable: 0 });

    const row = await t.run((ctx) => ctx.db.query("evaluations").withIndex("by_appId", (q) => q.eq("appId", ids.evaluation)).unique());
    expect(row).toMatchObject({ spacetimeCommitted: true, commitStatus: "committed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/call/record_evaluation");
  });

  it("keeps a failed bridge action pending while its grant remains valid", async () => {
    for (const [name, value] of Object.entries({
      SPACETIMEDB_MODE: "cloud",
      SPACETIMEDB_URI: "https://spacetime.example.invalid",
      SPACETIMEDB_DATABASE: "forksafe",
      FORKSAFE_BRIDGE_SECRET: "bridge-secret",
      SPACETIMEDB_BRIDGE_TOKEN: "bridge-token",
    })) vi.stubEnv(name, value);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      throw new Error("temporary network failure");
    }));
    const t = convexTest(schema, modules);
    const ids = await addPendingEvaluation(t);

    await expect(t.action(internal.evaluationReconcile.reconcilePendingCommits, {}))
      .resolves.toEqual({ checked: 1, committed: 0, pending: 1, failed: 0, notApplicable: 0 });

    const row = await t.run((ctx) => ctx.db.query("evaluations").withIndex("by_appId", (q) => q.eq("appId", ids.evaluation)).unique());
    expect(row).toMatchObject({ spacetimeCommitted: false, commitStatus: "pending", commitError: "bridge_call_failed" });
  });

  it("marks evaluations with revoked grants as failed without retrying them", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const t = convexTest(schema, modules);
    const ids = await addPendingEvaluation(t, true);

    await expect(t.action(internal.evaluationReconcile.reconcilePendingCommits, {}))
      .resolves.toEqual({ checked: 1, committed: 0, pending: 0, failed: 1, notApplicable: 0 });

    const row = await t.run((ctx) => ctx.db.query("evaluations").withIndex("by_appId", (q) => q.eq("appId", ids.evaluation)).unique());
    expect(row).toMatchObject({ spacetimeCommitted: false, commitStatus: "commit_failed", commitError: "grant_revoked" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
