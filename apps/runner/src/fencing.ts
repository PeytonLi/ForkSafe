import type { Lease } from "./protocol.js";

export class StaleLeaseError extends Error {
  constructor(message = "Lease is stale") {
    super(message);
    this.name = "StaleLeaseError";
  }
}

export function assertFence(lease: Lease, now: number): void {
  if (
    lease.grant.jobId !== lease.job.id
    || lease.grant.attemptId !== lease.attempt.id
    || lease.grant.epoch !== lease.attempt.epoch
    || lease.attempt.epoch !== lease.job.epoch
  ) throw new StaleLeaseError("Job, attempt, and grant fencing fields do not match");
  if (lease.grant.revokedAtMs !== undefined) throw new StaleLeaseError("Execution grant was revoked");
  if (lease.grant.expiresAtMs <= now || lease.attempt.leasedUntilMs <= now) throw new StaleLeaseError("Execution lease expired");
}
