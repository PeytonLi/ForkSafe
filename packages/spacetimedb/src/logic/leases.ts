import { LEASE_TTL_MS } from "./constants.js";
import type { GrantLike, LogicResult, RevisionLeaseLike } from "./types.js";

function leaseExpiry(nowMs: number, grant: Pick<GrantLike, "expiresAtMs">): number {
  return Math.min(nowMs + LEASE_TTL_MS, grant.expiresAtMs);
}

export function planLeaseAcquire(
  existingLease: RevisionLeaseLike | undefined,
  grant: Pick<GrantLike, "attemptId" | "id" | "epoch" | "expiresAtMs">,
  environmentId: string,
  nowMs: number,
): LogicResult<{ lease: RevisionLeaseLike }> {
  if (
    existingLease &&
    existingLease.expiresAtMs > nowMs &&
    existingLease.holderAttemptId !== grant.attemptId
  ) {
    return { ok: false, code: "lease_held", message: "Revision lease is held by another attempt" };
  }
  return {
    ok: true,
    lease: {
      environmentId,
      holderAttemptId: grant.attemptId,
      grantId: grant.id,
      epoch: grant.epoch,
      acquiredAtMs: existingLease?.holderAttemptId === grant.attemptId
        ? existingLease.acquiredAtMs
        : nowMs,
      renewedAtMs: nowMs,
      expiresAtMs: leaseExpiry(nowMs, grant),
    },
  };
}

export function planLeaseRenew(
  existingLease: RevisionLeaseLike | undefined,
  grant: Pick<GrantLike, "attemptId" | "id" | "epoch" | "expiresAtMs">,
  nowMs: number,
): LogicResult<{ lease: RevisionLeaseLike }> {
  if (!existingLease) {
    return { ok: false, code: "lease_missing", message: "Revision lease does not exist" };
  }
  if (
    existingLease.holderAttemptId !== grant.attemptId ||
    existingLease.grantId !== grant.id ||
    existingLease.epoch !== grant.epoch
  ) {
    return { ok: false, code: "lease_held", message: "Revision lease belongs to another grant or attempt" };
  }
  if (existingLease.expiresAtMs <= nowMs) {
    return { ok: false, code: "lease_expired", message: "Revision lease expired and must be reacquired" };
  }
  return {
    ok: true,
    lease: { ...existingLease, renewedAtMs: nowMs, expiresAtMs: leaseExpiry(nowMs, grant) },
  };
}
