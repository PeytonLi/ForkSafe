import { Attempt, ExecutionGrant, Job } from "@forksafe/contracts";
import type { Lease } from "../src/protocol.js";

export function sampleLease(now = Date.now()): Lease {
  const investigationId = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  const job = Job.parse({
    id: crypto.randomUUID(), kind: "factory_session", state: "granted",
    investigationId, environmentId, epoch: 0,
    idempotencyKey: "factory-session-test-key",
    payload: { prompt: "test" }, attemptsUsed: 0, maxAttempts: 2,
    createdAtMs: now, updatedAtMs: now,
  });
  const attempt = Attempt.parse({
    id: crypto.randomUUID(), jobId: job.id, epoch: 0, state: "leased",
    workerId: "test-worker", leasedUntilMs: now + 30_000, lastHeartbeatMs: now, startedAtMs: now,
  });
  const grant = ExecutionGrant.parse({
    id: crypto.randomUUID(), jobId: job.id, attemptId: attempt.id, epoch: 0,
    investigationId, environmentId, scope: { operations: [], artifactPrefixes: [], maxBytes: 0 },
    expiresAtMs: now + 30_000,
  });
  return { job, attempt, grant };
}
