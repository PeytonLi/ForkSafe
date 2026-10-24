import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.js";
import { api, internal } from "../_generated/api.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
  .glob("../**/*.ts");
const token = "convex-test-service-token";
const resources = { cpu: 2, memoryGiB: 2, diskGiB: 10 };

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkpool(t, "daytonaPool");
  return t;
}

afterEach(() => vi.unstubAllEnvs());

describe("sandbox admission queue", () => {
  it("admits five of six runner requests and fills the released slot FIFO", async () => {
    vi.stubEnv("DAYTONA_MAX_ACTIVE_SANDBOXES", "5");
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    const t = createTest();
    const created = await t.mutation(api.investigations.create, {
      title: "Sandbox capacity",
      requestedEnvironments: 6,
      idempotencyKey: crypto.randomUUID(),
      serviceToken: token,
    });
    await t.run(async (ctx: any) => {
      for (let index = 0; index < 6; index += 1) {
        await ctx.db.insert("environments", {
          appId: crypto.randomUUID(), investigationId: created.investigationId, index,
          state: "provisioning",
          budgets: { maxExperiments: 10, maxCandidates: 2, maxFactorySessions: 2, wallTimeMs: 60_000 },
          experimentsUsed: 0, candidatesUsed: 0,
        });
      }
    });
    const environments = await t.run(async (ctx: any) =>
      await ctx.db.query("environments").withIndex("by_investigation", (q: any) => q.eq("investigationId", created.investigationId)).collect(),
    );
    const requests = [];
    for (const environment of environments) {
      requests.push(await t.mutation(internal.sandboxes.requestSandbox, {
        purpose: "runner", investigationId: created.investigationId, environmentId: environment.appId,
        snapshot: "forksafe-runner-v1", resources, provider: "daytona",
      }));
    }
    expect(requests.slice(0, 5).every((request: any) => !request.queued)).toBe(true);
    expect(requests[5]).toMatchObject({ queued: true, localWorkerRequired: false });
    expect(await t.run(async (ctx: any) => await ctx.db.query("reservations")
      .withIndex("by_kind_status", (q: any) => q.eq("kind", "sandbox").eq("status", "active")).collect())).toHaveLength(5);
    expect((await t.run(async (ctx: any) =>
      await ctx.db.query("environments").withIndex("by_appId", (q: any) => q.eq("appId", environments[5]!.appId)).unique(),
    ))?.queuedReason).toBe("sandbox_capacity_exhausted");

    await t.mutation(internal.sandboxes.updateSandboxOp, {
      sandboxOpId: requests[0]!.sandboxOpId, status: "terminated",
      releaseReservation: true, terminatedAtMs: Date.now(),
    });
    await t.mutation(internal.sandboxes.admitQueued, {});
    expect((await t.query(internal.sandboxes.getSandboxOp, { sandboxOpId: requests[5]!.sandboxOpId }))?.status).toBe("requested");
  });

  it("admits queued operations FIFO after capacity is released and closes queued work for failed investigations", async () => {
    vi.stubEnv("DAYTONA_MAX_ACTIVE_SANDBOXES", "1");
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    const t = createTest();
    const created = await t.mutation(api.investigations.create, {
      title: "Sandbox queue",
      requestedEnvironments: 1,
      idempotencyKey: crypto.randomUUID(),
      serviceToken: token,
    });
    const environmentId = crypto.randomUUID();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("environments", {
        appId: environmentId,
        investigationId: created.investigationId,
        index: 0,
        state: "provisioning",
        budgets: { maxExperiments: 10, maxCandidates: 2, maxFactorySessions: 2, wallTimeMs: 60_000 },
        experimentsUsed: 0,
        candidatesUsed: 0,
      });
    });
    const request = (environmentId?: string, investigationId = created.investigationId) => t.mutation(internal.sandboxes.requestSandbox, {
      purpose: "runner" as const,
      investigationId,
      ...(environmentId ? { environmentId } : {}),
      snapshot: "forksafe-runner-v1",
      resources,
      provider: "daytona" as const,
    });
    const first = await request();
    const second = await request(environmentId);
    const third = await request();
    expect(second).toMatchObject({ queued: true, localWorkerRequired: false });
    expect(third).toMatchObject({ queued: true, localWorkerRequired: false });
    expect(await t.run((ctx: any) => ctx.db.query("reservations").collect())).toHaveLength(1);
    expect(await t.run(async (ctx: any) =>
      (await ctx.db.query("environments").withIndex("by_appId", (q: any) => q.eq("appId", environmentId)).unique())?.queuedReason,
    )).toBe("sandbox_capacity_exhausted");

    await t.mutation(internal.sandboxes.updateSandboxOp, {
      sandboxOpId: first.sandboxOpId,
      status: "terminated",
      releaseReservation: true,
      terminatedAtMs: Date.now(),
    });
    await t.mutation(internal.sandboxes.admitQueued, {});
    expect((await t.query(internal.sandboxes.getSandboxOp, { sandboxOpId: second.sandboxOpId }))?.status).toBe("requested");
    expect((await t.query(internal.sandboxes.getSandboxOp, { sandboxOpId: third.sandboxOpId }))?.status).toBe("queued");
    expect(await t.run(async (ctx: any) =>
      (await ctx.db.query("environments").withIndex("by_appId", (q: any) => q.eq("appId", environmentId)).unique())?.queuedReason,
    )).toBeFalsy();

    const closed = await t.mutation(api.investigations.create, {
      title: "Closed queue",
      requestedEnvironments: 1,
      idempotencyKey: crypto.randomUUID(),
      serviceToken: token,
    });
    const fourth = await request(undefined, closed.investigationId);
    await t.run(async (ctx: any) => {
      const row = await ctx.db.query("investigations")
        .withIndex("by_appId", (q: any) => q.eq("appId", closed.investigationId))
        .unique();
      await ctx.db.patch(row!._id, { state: "failed" });
    });
    await t.mutation(internal.sandboxes.admitQueued, {});
    expect((await t.query(internal.sandboxes.getSandboxOp, { sandboxOpId: fourth.sandboxOpId }))?.status).toBe("terminated");
  });
});
