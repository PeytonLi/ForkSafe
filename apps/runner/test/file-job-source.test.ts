import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Job } from "@forksafe/contracts";
import { FileJobSource } from "../src/job-source.js";

const dirs: string[] = [];
async function setup() {
  let now = 10_000;
  const dir = await mkdtemp(join(tmpdir(), "forksafe-jobs-"));
  dirs.push(dir);
  await mkdir(join(dir, "jobs"), { recursive: true });
  const job = Job.parse({
    id: crypto.randomUUID(), kind: "factory_session", state: "granted",
    investigationId: crypto.randomUUID(), environmentId: crypto.randomUUID(),
    epoch: 0, idempotencyKey: "job-idempotency-key",
    payload: { prompt: "test" }, attemptsUsed: 0, maxAttempts: 2,
    createdAtMs: now, updatedAtMs: now,
  });
  await writeFile(join(dir, "jobs", `${job.id}.json`), JSON.stringify(job));
  return { dir, job, source: new FileJobSource(dir, () => now), setNow: (value: number) => { now = value; } };
}

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("FileJobSource", () => {
  it("mints a lease and fences an expired attempt on takeover", async () => {
    const { source, setNow } = await setup();
    const first = await source.claim({ workerId: "worker-a", kinds: ["factory_session"], capacity: 1 });
    expect(first).not.toBeNull();
    expect(first!.attempt.epoch).toBe(0);
    expect(first!.grant.attemptId).toBe(first!.attempt.id);
    setNow(first!.attempt.leasedUntilMs);
    const second = await source.claim({ workerId: "worker-b", kinds: ["factory_session"], capacity: 1 });
    expect(second!.job.epoch).toBe(1);
    expect(second!.attempt.epoch).toBe(1);
    expect(await source.heartbeat({
      attemptId: first!.attempt.id, grantId: first!.grant.id, epoch: first!.attempt.epoch, atMs: first!.attempt.leasedUntilMs,
    })).toEqual({ ok: false, reason: "fenced" });
    const oldCompletion = {
      operationId: crypto.randomUUID(), jobId: first!.job.id, attemptId: first!.attempt.id,
      grantId: first!.grant.id, epoch: first!.attempt.epoch, outcome: "succeeded" as const,
      result: {}, sessions: [], finishedAtMs: first!.attempt.leasedUntilMs,
    };
    expect(await source.complete(oldCompletion)).toEqual({ accepted: false, reason: "fenced" });
  });

  it("renews and accepts a matching completion once per operation ID", async () => {
    const { source } = await setup();
    const lease = (await source.claim({ workerId: "worker", kinds: ["factory_session"], capacity: 1 }))!;
    const heartbeat = await source.heartbeat({
      attemptId: lease.attempt.id, grantId: lease.grant.id, epoch: lease.attempt.epoch, atMs: 10_001,
    });
    expect(heartbeat.ok).toBe(true);
    if (heartbeat.ok) expect(heartbeat.grantExpiresAtMs).toBe(heartbeat.leasedUntilMs);
    const completion = {
      operationId: crypto.randomUUID(), jobId: lease.job.id, attemptId: lease.attempt.id,
      grantId: lease.grant.id, epoch: lease.attempt.epoch, outcome: "succeeded" as const,
      result: { done: true }, sessions: [], finishedAtMs: 10_002,
    };
    expect(await source.complete(completion)).toEqual({ accepted: true });
    expect(await source.complete(completion)).toEqual({ accepted: true });
    const job = Job.parse(JSON.parse(await readFile(join(dirs.at(-1)!, "jobs", `${lease.job.id}.json`), "utf8")));
    expect(job.state).toBe("succeeded");
  });
});
