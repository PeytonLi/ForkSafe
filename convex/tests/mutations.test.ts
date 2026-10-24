import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.js";
import { api, internal } from "../_generated/api.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
  .glob("../**/*.ts");
const token = "convex-test-service-token";
const investigationId = "00000000-0000-4000-8000-000000000001";

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

async function createStartedJob(t: any) {
  const created = await t.mutation(api.investigations.create, {
    title: "Hermetic lifecycle",
    requestedEnvironments: 1,
    idempotencyKey: crypto.randomUUID(),
    serviceToken: token,
  });
  await t.mutation(api.investigations.start, {
    investigationId: created.investigationId,
    expectedVersion: 1,
    serviceToken: token,
  });
  const rows = await t.run(async (ctx: any) => ({
    job: (await ctx.db.query("jobs").collect())[0]!,
    environment: (await ctx.db.query("environments").collect())[0]!,
  }));
  await t.run(async (ctx: any) => {
    await ctx.db.patch(rows.environment._id, { state: "active" });
  });
  return { ...rows, investigationId: created.investigationId };
}

describe("Convex lifecycle mutations", () => {
  beforeEach(() => vi.stubEnv("DAYTONA_MODE", "local"));
  afterEach(() => vi.unstubAllEnvs());

  it("creates, starts, claims, heartbeats, stages, and completes a job", async () => {
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    const t = createTest();
    const { job } = await createStartedJob(t);
    const claim = await t.mutation(api.workers.claim, { jobId: job.appId, workerId: "worker-a", serviceToken: token });
    await t.mutation(api.workers.heartbeat, {
      jobId: job.appId, attemptId: claim.attemptId, epoch: claim.epoch, workerId: "worker-a", serviceToken: token,
    });
    for (const stage of ["grant_installed", "work_started", "artifacts_persisted", "evidence_committed"] as const) {
      await t.mutation(api.workers.recordStage, {
        jobId: job.appId, attemptId: claim.attemptId, epoch: claim.epoch, stage, serviceToken: token,
      });
    }
    const complete = await t.mutation(api.workers.complete, {
      jobId: job.appId, attemptId: claim.attemptId, epoch: claim.epoch, outcome: "succeeded", serviceToken: token,
    });
    expect(complete).toMatchObject({ jobState: "succeeded", retry: false });
  });

  it("rejects auth, reclaims after expiry, and fences stale completion", async () => {
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    const t = createTest();
    const { job } = await createStartedJob(t);
    await expect(t.mutation(api.workers.claim, {
      jobId: job.appId, workerId: "worker-a", serviceToken: "wrong",
    })).rejects.toThrow("unauthorized");

    const first = await t.mutation(api.workers.claim, { jobId: job.appId, workerId: "worker-a", serviceToken: token });
    await t.mutation(api.workers.recordStage, {
      jobId: job.appId, attemptId: first.attemptId, epoch: first.epoch, stage: "grant_installed", serviceToken: token,
    });
    await t.mutation(api.workers.recordStage, {
      jobId: job.appId, attemptId: first.attemptId, epoch: first.epoch, stage: "work_started", serviceToken: token,
    });
    const expiredAt = first.leaseExpiresAtMs + 1;
    await t.mutation(internal.reconcile.tick, { now: expiredAt });
    await t.mutation(internal.workers.acknowledgeGrantRevocation, {
      jobId: job.appId, attemptId: first.attemptId, epoch: first.epoch,
    });
    const second = await t.mutation(api.workers.claim, { jobId: job.appId, workerId: "worker-b", serviceToken: token });
    expect(second.epoch).toBe(first.epoch + 1);
    const stale = await t.mutation(api.workers.complete, {
      jobId: job.appId, attemptId: first.attemptId, epoch: first.epoch, outcome: "succeeded", serviceToken: token,
    });
    expect(stale).toMatchObject({ rejected: true, reason: "stale_epoch" });
    expect((await t.query(api.workers.getJob, { jobId: job.appId, serviceToken: token }))?.activeAttemptId).toBe(second.attemptId);
  });

  it("enforces one model turn per session and the global four-turn cap", async () => {
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    const t = createTest();
    const envId = "00000000-0000-4000-8000-000000000002";
    for (let index = 0; index < 4; index += 1) {
      await t.mutation(api.workers.reserveModelTurn, {
        investigationId, environmentId: envId, sessionId: `session-${index}`, serviceToken: token,
      });
    }
    await expect(t.mutation(api.workers.reserveModelTurn, {
      investigationId, environmentId: envId, sessionId: "session-0", serviceToken: token,
    })).rejects.toThrow("session_capacity_exhausted");
    await expect(t.mutation(api.workers.reserveModelTurn, {
      investigationId, environmentId: envId, sessionId: "session-extra", serviceToken: token,
    })).rejects.toThrow("global_capacity_exhausted");
  });

  it("reconciles evidence committed after a worker crash", async () => {
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    const t = createTest();
    const { job } = await createStartedJob(t);
    const claim = await t.mutation(api.workers.claim, { jobId: job.appId, workerId: "worker-a", serviceToken: token });
    for (const stage of ["grant_installed", "work_started", "artifacts_persisted", "evidence_committed"] as const) {
      await t.mutation(api.workers.recordStage, {
        jobId: job.appId, attemptId: claim.attemptId, epoch: claim.epoch, stage, serviceToken: token,
      });
    }
    const result = await t.mutation(internal.reconcile.tick, {});
    expect(result.acknowledged).toBe(1);
    expect((await t.query(api.workers.getJob, { jobId: job.appId, serviceToken: token }))?.state).toBe("succeeded");
  });

  it("cancels an active job after the hard-stop deadline", async () => {
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    const t = createTest();
    const { job, investigationId: id } = await createStartedJob(t);
    await t.mutation(api.workers.claim, { jobId: job.appId, workerId: "worker-a", serviceToken: token });
    await t.mutation(api.investigations.cancel, {
      investigationId: id, expectedVersion: 2, serviceToken: token,
    });
    await t.mutation(internal.reconcile.tick, { now: Date.now() + 30_001 });
    expect((await t.query(api.investigations.get, { investigationId: id, serviceToken: token }))?.cancelStatus).toBe("cancelled");
  });

  it("queues sandbox operations when retained ambiguous operations exhaust capacity", async () => {
    vi.stubEnv("DAYTONA_MAX_ACTIVE_SANDBOXES", "1");
    const t = createTest();
    await t.mutation(internal.sandboxes.requestSandbox, {
      purpose: "execution", investigationId, snapshot: "forksafe-exec-v1",
      resources: { cpu: 2, memoryGiB: 4, diskGiB: 10 }, provider: "daytona",
    });
    const operation = (await t.run((ctx) => ctx.db.query("sandboxOps").first()))!;
    await t.mutation(internal.sandboxes.updateSandboxOp, {
      sandboxOpId: operation.appId, status: "ambiguous_create",
    });
    const queued = await t.mutation(internal.sandboxes.requestSandbox, {
      purpose: "execution", investigationId, snapshot: "forksafe-exec-v1",
      resources: { cpu: 2, memoryGiB: 4, diskGiB: 10 }, provider: "daytona",
    });
    expect(queued).toMatchObject({ queued: true, localWorkerRequired: false });
    const reservations = await t.run((ctx) => ctx.db.query("reservations").collect());
    expect(reservations).toHaveLength(1);
    expect((await t.query(internal.sandboxes.getSandboxOp, { sandboxOpId: queued.sandboxOpId }))?.status).toBe("queued");
  });
});
