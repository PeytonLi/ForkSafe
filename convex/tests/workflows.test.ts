import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.js";
import { api, internal } from "../_generated/api.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
  .glob("../**/*.ts");
const serviceToken = "workflow-resilience-test-token";

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  vi.stubEnv("INTEGRATION_SHARED_SECRET", serviceToken);
  vi.stubEnv("SPACETIMEDB_MODE", "fixture");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("resilience workflow paths", () => {
  it("activates external-runner environments without runner sandbox operations when execution is queued", async () => {
    vi.stubEnv("RUNNER_LAUNCH_MODE", "external");
    vi.stubEnv("DAYTONA_MAX_ACTIVE_SANDBOXES", "1");
    const t = createTest();
    const created = await t.mutation(api.investigations.create, {
      title: "External runner", requestedEnvironments: 1,
      idempotencyKey: crypto.randomUUID(), serviceToken,
    });
    await t.mutation(api.investigations.start, {
      investigationId: created.investigationId, expectedVersion: 1, serviceToken,
    });
    await t.run(async (ctx: any) => {
      await ctx.db.insert("reservations", {
        appId: crypto.randomUUID(), kind: "sandbox", status: "active",
        investigationId: created.investigationId, holder: {},
        operationId: crypto.randomUUID(), createdAtMs: Date.now(),
      });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run(async (ctx: any) => ({
      environments: await ctx.db.query("environments")
        .withIndex("by_investigation", (q: any) => q.eq("investigationId", created.investigationId)).collect(),
      operations: await ctx.db.query("sandboxOps")
        .withIndex("by_investigation", (q: any) => q.eq("investigationId", created.investigationId)).collect(),
      credentials: await ctx.db.query("runnerCredentials")
        .withIndex("by_investigation", (q: any) => q.eq("investigationId", created.investigationId)).collect(),
    }));
    expect(rows.operations.some((op: any) => op.purpose === "execution" && op.status === "queued")).toBe(true);
    expect(rows.operations.some((op: any) => op.purpose === "runner")).toBe(false);
    expect(rows.environments.every((environment: any) => environment.state === "active")).toBe(true);
    expect(rows.credentials).toHaveLength(1);
    expect(rows.credentials[0].sandboxOpId).toBeUndefined();
  });

  it("sanitizes workflow failures and finalizes environments, investigations, ops, and credentials", async () => {
    vi.stubEnv("DAYTONA_MAX_ACTIVE_SANDBOXES", "1");
    const t = createTest();
    const created = await t.mutation(api.investigations.create, {
      title: "Workflow failure", requestedEnvironments: 1,
      idempotencyKey: crypto.randomUUID(), serviceToken,
    });
    const environment = await t.run(async (ctx: any) => {
      const row = {
        appId: crypto.randomUUID(), investigationId: created.investigationId, index: 0,
        state: "active", budgets: { maxExperiments: 10, maxCandidates: 2, maxFactorySessions: 2, wallTimeMs: 60_000 },
        experimentsUsed: 0, candidatesUsed: 0,
      };
      await ctx.db.insert("environments", row);
      await ctx.db.patch(
        (await ctx.db.query("investigations").withIndex("by_appId", (q: any) => q.eq("appId", created.investigationId)).unique())!._id,
        { state: "searching" },
      );
      await ctx.db.insert("reservations", {
        appId: crypto.randomUUID(), kind: "sandbox", status: "active",
        investigationId: created.investigationId, holder: {},
        operationId: crypto.randomUUID(), createdAtMs: Date.now(),
      });
      return row;
    });
    const credential = await t.mutation(internal.runnerControl.issueCredential, {
      investigationId: created.investigationId, environmentId: environment.appId,
    });
    const queued = await t.mutation(internal.sandboxes.requestSandbox, {
      purpose: "runner", investigationId: created.investigationId, environmentId: environment.appId,
      snapshot: "forksafe-runner-v1", resources: { cpu: 2, memoryGiB: 2, diskGiB: 10 }, provider: "daytona",
    });
    const callbackArgs = {
      workflowId: "workflow-failure-test",
      context: { investigationId: created.investigationId },
      result: { kind: "failed", error: "Bearer should-not-be-persisted" },
    };
    expect(await t.mutation(internal.workflows.onWorkflowComplete, callbackArgs)).toEqual({ handled: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run(async (ctx: any) => ({
      investigation: await ctx.db.query("investigations")
        .withIndex("by_appId", (q: any) => q.eq("appId", created.investigationId)).unique(),
      environment: await ctx.db.query("environments")
        .withIndex("by_appId", (q: any) => q.eq("appId", environment.appId)).unique(),
      operation: await ctx.db.query("sandboxOps")
        .withIndex("by_appId", (q: any) => q.eq("appId", queued.sandboxOpId)).unique(),
      credential: await ctx.db.query("runnerCredentials")
        .withIndex("by_appId", (q: any) => q.eq("appId", credential.credentialId)).unique(),
    }));
    expect(rows.investigation).toMatchObject({ state: "failed", lastError: "workflow_failed" });
    expect(rows.environment).toMatchObject({ state: "error", lastError: "workflow_failed" });
    expect(rows.operation).toMatchObject({ status: "terminated", lastError: "workflow_failed" });
    expect(rows.credential?.revokedAtMs).toEqual(expect.any(Number));
    expect(JSON.stringify(rows)).not.toContain("should-not-be-persisted");
  });
});
