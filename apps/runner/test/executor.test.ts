import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityLog, FixtureFactoryAdapter, SessionManager, UsageLedger } from "@forksafe/agents";
import { Job } from "@forksafe/contracts";
import { FileJobSource } from "../src/job-source.js";
import { LocalToolBackend } from "../src/tool-backend.js";
import { RunnerExecutor } from "../src/executor.js";
import { sampleLease } from "./helpers.js";

const dirs: string[] = [];
async function setup(adapter = new FixtureFactoryAdapter()) {
  const dir = await mkdtemp(join(tmpdir(), "forksafe-executor-"));
  dirs.push(dir);
  const manager = new SessionManager({
    adapter, ledger: new UsageLedger(), workspaceRoot: join(dir, "workspaces"),
    toolBackend: new LocalToolBackend(join(dir, "local")), log: new ActivityLog(),
  });
  return { dir, manager };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("RunnerExecutor", () => {
  it("completes fixture work with usage and local vendor reference", async () => {
    const { dir, manager } = await setup();
    const jobsDir = join(dir, "jobs", "jobs");
    await mkdir(jobsDir, { recursive: true });
    const job = Job.parse({
      id: crypto.randomUUID(), kind: "factory_session", state: "granted",
      investigationId: crypto.randomUUID(), environmentId: crypto.randomUUID(),
      epoch: 0, idempotencyKey: "executor-test-idempotency",
      payload: { prompt: "test" }, attemptsUsed: 0, maxAttempts: 2,
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    await writeFile(join(jobsDir, `${job.id}.json`), JSON.stringify(job));
    const jobSource = new FileJobSource(join(dir, "jobs"));
    const lease = (await jobSource.claim({ workerId: "test", kinds: ["factory_session"], capacity: 1 }))!;
    const executor = new RunnerExecutor({ sessions: manager, source: jobSource, log: new ActivityLog() });
    const result = await executor.execute(lease);
    expect(result).toMatchObject({ accepted: true });
    const state = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "jobs", "state.json"), "utf8"));
    const completion = Object.values(state.completions)[0] as { response: unknown };
    expect(completion.response).toEqual({ accepted: true });
    const session = [...(manager as unknown as { sessions: Map<string, never> }).sessions.values()][0] as unknown as {
      adapterSession: { vendorId: string };
    };
    expect(session.adapterSession.vendorId).toBe("fixture-session-0001");
  });

  it("does not post a result after the lease is fenced mid-turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const { manager } = await setup(new FixtureFactoryAdapter({
      gate: () => { markEntered(); return gate; },
    }));
    const lease = sampleLease(20_000);
    const source = {
      heartbeat: vi.fn(async () => ({ ok: false as const, reason: "fenced" as const })),
      complete: vi.fn(async () => ({ accepted: true })),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog() });
    const task = executor.execute(lease);
    await entered;
    await vi.advanceTimersByTimeAsync(5_000);
    release();
    await expect(task).resolves.toBeNull();
    expect(source.heartbeat).toHaveBeenCalledOnce();
    expect(source.complete).not.toHaveBeenCalled();
  });

  it("uses two sessions for concurrent jobs and fails a third at the environment cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let enteredCount = 0;
    let markBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => { markBothEntered = resolve; });
    const adapter = new FixtureFactoryAdapter({
      gate: () => {
        enteredCount += 1;
        if (enteredCount === 2) markBothEntered();
        return gate;
      },
    });
    const { manager } = await setup(adapter);
    const baseLease = sampleLease();
    const siblingLease = (): typeof baseLease => {
      const lease = structuredClone(baseLease);
      lease.job.id = crypto.randomUUID();
      lease.job.idempotencyKey = crypto.randomUUID();
      lease.attempt.id = crypto.randomUUID();
      lease.attempt.jobId = lease.job.id;
      lease.grant.id = crypto.randomUUID();
      lease.grant.jobId = lease.job.id;
      lease.grant.attemptId = lease.attempt.id;
      return lease;
    };
    const secondLease = siblingLease();
    const thirdLease = siblingLease();
    const completions: {
      jobId: string;
      outcome: string;
      result: Record<string, unknown>;
      sessions: { provider: string; id: string }[];
    }[] = [];
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: {
        jobId: string;
        outcome: string;
        result: Record<string, unknown>;
        sessions: { provider: string; id: string }[];
      }) => {
        completions.push(completion);
        return { accepted: true };
      }),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog() });
    const firstTask = executor.execute(baseLease);
    const secondTask = executor.execute(secondLease);
    await bothEntered;

    expect(manager.idleSessionFor(baseLease.job.investigationId, baseLease.job.environmentId!)).toBeUndefined();
    await expect(executor.execute(thirdLease)).resolves.toMatchObject({ accepted: true });
    const capCompletion = completions.find((completion) => completion.jobId === thirdLease.job.id);
    expect(capCompletion).toMatchObject({
      outcome: "failed",
      result: { error: "environment_session_cap" },
      sessions: [],
    });

    release();
    await expect(Promise.all([firstTask, secondTask])).resolves.toEqual([
      { accepted: true },
      { accepted: true },
    ]);
    const usedSessions = completions
      .filter((completion) => completion.jobId !== thirdLease.job.id)
      .flatMap((completion) => completion.sessions.map((session) => session.id));
    expect(new Set(usedSessions).size).toBe(2);
    expect(enteredCount).toBe(2);
  });

  it("retries a thrown completion with the same operation ID", async () => {
    const { manager } = await setup();
    const lease = sampleLease();
    const operationIds: string[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: { operationId: string }) => {
        operationIds.push(completion.operationId);
        attempts += 1;
        if (attempts === 1) throw new Error("network unavailable");
        return { accepted: true };
      }),
    };
    const executor = new RunnerExecutor({
      sessions: manager,
      source: source as never,
      log: new ActivityLog(),
      sleep: async (ms) => { delays.push(ms); },
    });

    await expect(executor.execute(lease)).resolves.toEqual({ accepted: true });
    expect(source.complete).toHaveBeenCalledTimes(2);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[0]).toMatch(/^[\da-f-]{36}$/);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(delays).toEqual([250]);
  });
  it("reports a non-cap session-open failure as infra_failed instead of letting the lease expire", async () => {
    const lease = sampleLease();
    const completions: { outcome: string; result: Record<string, unknown> }[] = [];
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: { outcome: string; result: Record<string, unknown> }) => {
        completions.push(completion);
        return { accepted: true };
      }),
    };
    const sessions = {
      idleSessionFor: () => undefined,
      createSession: async () => { throw new Error("Failed to start Droid: executable not found (droid)"); },
    };
    const executor = new RunnerExecutor({ sessions: sessions as never, source: source as never, log: new ActivityLog() });
    await expect(executor.execute(lease)).resolves.toMatchObject({ accepted: true });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ outcome: "infra_failed" });
    expect(String(completions[0]!.result.error)).toMatch(/^session_open_failed:Failed to start Droid/);
    expect(source.heartbeat).not.toHaveBeenCalled();
  });
});
