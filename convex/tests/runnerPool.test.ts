import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.js";
import { api, internal } from "../_generated/api.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> }).glob("../**/*.ts");
const serviceToken = "runner-pool-test-service-token";
const poolToken = "dedicated-pool-test-token";

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

async function waitingEnvironment(t: any) {
  const created = await t.mutation(api.investigations.create, {
    title: "runner pool",
    requestedEnvironments: 1,
    idempotencyKey: crypto.randomUUID(),
    serviceToken,
  });
  await t.mutation(api.investigations.start, {
    investigationId: created.investigationId,
    expectedVersion: 1,
    serviceToken,
  });
  const environment = await t.run(async (ctx: any) => {
    const row = (await ctx.db.query("environments").collect())[0]!;
    await ctx.db.patch(row._id, { state: "active", startedAtMs: Date.now() });
    await ctx.db.insert("sandboxOps", {
      appId: crypto.randomUUID(),
      purpose: "execution",
      investigationId: created.investigationId,
      snapshot: "execution-v1",
      resources: { cpu: 2, memoryGiB: 2, diskGiB: 10 },
      provider: "daytona",
      sandbox: { provider: "daytona", id: "execution-sandbox" },
      status: "ready",
      reservationId: crypto.randomUUID(),
      attempts: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    return row;
  });
  return { investigationId: created.investigationId, environmentId: environment.appId };
}

beforeEach(() => {
  vi.stubEnv("INTEGRATION_SHARED_SECRET", serviceToken);
  vi.stubEnv("RUNNER_POOL_TOKEN", poolToken);
  vi.stubEnv("RUNNER_LAUNCH_MODE", "external");
  vi.stubEnv("SPACETIMEDB_MODE", "fixture");
});
afterEach(() => vi.unstubAllEnvs());

describe("runner pool claims", () => {
  it("atomically reserves the oldest eligible environment and fences a second worker", async () => {
    const t = createTest();
    const waiting = await waitingEnvironment(t);

    const first = await t.mutation(internal.runnerPool.claim, { poolWorkerId: "pool-worker-one" });
    expect(first).toMatchObject({
      environmentId: waiting.environmentId,
      investigationId: waiting.investigationId,
      expiresAtMs: expect.any(Number),
    });
    expect(first!.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await t.mutation(internal.runnerPool.claim, { poolWorkerId: "pool-worker-two" })).toBeNull();
    const reservation = await t.run(async (ctx: any) => await ctx.db.query("environments")
      .withIndex("by_appId", (q: any) => q.eq("appId", waiting.environmentId)).unique());
    expect(reservation).toMatchObject({
      poolWorkerId: "pool-worker-one",
      leasedUntilMs: expect.any(Number),
      runnerCredentialId: first!.credentialId,
    });
  });

  it("releases and revokes a cleanly stopped pool credential", async () => {
    const t = createTest();
    const waiting = await waitingEnvironment(t);
    const claim = await t.mutation(internal.runnerPool.claim, { poolWorkerId: "pool-worker-one" });
    expect(claim).not.toBeNull();

    await expect(t.mutation(internal.runnerPool.release, {
      poolWorkerId: "pool-worker-one",
      credentialId: claim!.credentialId,
    })).resolves.toEqual({ released: true });
    const rows = await t.run(async (ctx: any) => ({
      environment: await ctx.db.query("environments")
        .withIndex("by_appId", (q: any) => q.eq("appId", waiting.environmentId)).unique(),
      credential: await ctx.db.query("runnerCredentials")
        .withIndex("by_appId", (q: any) => q.eq("appId", claim!.credentialId)).unique(),
    }));
    expect(rows.environment?.leasedUntilMs).toBeUndefined();
    expect(rows.credential).toMatchObject({ revokeReason: "pool_release", revokedAtMs: expect.any(Number) });
  });

  it("renews the pool reservation through the existing runner heartbeat", async () => {
    const t = createTest();
    const waiting = await waitingEnvironment(t);
    const poolClaim = await t.mutation(internal.runnerPool.claim, { poolWorkerId: "pool-worker-one" });
    const runnerClaim = await t.mutation(internal.runnerControl.claim, {
      credentialId: poolClaim!.credentialId,
      workerId: "pool-worker-one",
    });
    expect(runnerClaim).not.toBeNull();
    const lease = runnerClaim!.claimed;
    const grant = await t.mutation(internal.grants.create, {
      jobId: runnerClaim!.job.appId,
      attemptId: lease.attemptId,
      epoch: lease.epoch,
      investigationId: waiting.investigationId,
      environmentId: waiting.environmentId,
      purpose: "runner",
    });
    await t.mutation(internal.grants.markInstalled, { grantId: grant.grantId, committed: true, mode: "fixture" });
    await t.mutation(internal.runnerControl.markGrantInstalled, {
      credentialId: poolClaim!.credentialId,
      attemptId: lease.attemptId,
      epoch: lease.epoch,
      grantId: grant.grantId,
      bridgeMode: "fixture",
    });
    await t.run(async (ctx: any) => {
      const environment = await ctx.db.query("environments")
        .withIndex("by_appId", (q: any) => q.eq("appId", waiting.environmentId)).unique();
      await ctx.db.patch(environment._id, { leasedUntilMs: Date.now() + 1 });
    });
    const renewedAfterMs = Date.now();
    await t.mutation(internal.runnerControl.heartbeat, {
      credentialId: poolClaim!.credentialId,
      attemptId: lease.attemptId,
      grantId: grant.grantId,
      epoch: lease.epoch,
    });
    const environment = await t.run(async (ctx: any) => await ctx.db.query("environments")
      .withIndex("by_appId", (q: any) => q.eq("appId", waiting.environmentId)).unique());
    expect(environment?.leasedUntilMs).toBeGreaterThan(renewedAfterMs + 80_000);
  });

  it("requires the dedicated pool token and returns 503 when it is not configured", async () => {
    const t = createTest();
    const body = JSON.stringify({ poolWorkerId: "pool-worker" });
    const unauthorized = await t.fetch("/runner/pool/claim", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body,
    });
    expect(unauthorized.status).toBe(401);

    vi.stubEnv("RUNNER_POOL_TOKEN", "");
    const missing = await t.fetch("/runner/pool/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${poolToken}`, "content-type": "application/json" },
      body,
    });
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toEqual({ error: "pool_not_configured" });
  });

  it("returns 204 when no active external environment is waiting", async () => {
    const t = createTest();
    const response = await t.fetch("/runner/pool/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${poolToken}`, "content-type": "application/json" },
      body: JSON.stringify({ poolWorkerId: "pool-worker" }),
    });
    expect(response.status).toBe(204);
  });
});
