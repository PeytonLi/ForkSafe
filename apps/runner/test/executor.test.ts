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
});
