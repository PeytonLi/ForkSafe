import {
  HARD_STOP_DEADLINE_MS,
  LEASE_EXPIRY_MS,
} from "./constants.js";

type Job = {
  appId: string;
  state: string;
  epoch: number;
  activeAttemptId?: string;
  attemptsUsed: number;
  maxAttempts: number;
  admittedCancelEpoch: number;
  pendingRevocation?: {
    attemptId: string;
    grantId?: string;
    epoch: number;
    grantExpiresAtMs: number;
  };
  leaseExpiresAtMs?: number;
  cancelRequestedAtMs?: number;
};

type Attempt = {
  appId: string;
  epoch: number;
  state: string;
  workerId?: string;
  leasedUntilMs: number;
  startedAtMs: number;
  grantId?: string;
  grantExpiresAtMs?: number;
};

type Investigation = {
  cancelStatus: "none" | "cancel_requested" | "cancelled";
  cancelEpoch: number;
};

type Flags = { admissionPaused: boolean };

export function decideClaim(
  job: Job,
  prevAttempt: Attempt | null,
  investigation: Investigation,
  flags: Flags,
  now: number,
  workerId: string,
  dependencyStates: readonly string[] = [],
  revokedGrantIds: ReadonlySet<string> = new Set(),
):
  | {
      ok: true;
      newEpoch: number;
      attempt: { epoch: number; state: "leased"; leasedUntilMs: number };
      job: {
        state: "grant_pending";
        epoch: number;
        activeAttemptId: string;
        attemptsUsed: number;
        leaseExpiresAtMs: number;
        workerId: string;
        pendingRevocation: undefined;
      };
    }
  | { ok: false; reason: string } {
  if (flags.admissionPaused) return { ok: false, reason: "admission_paused" };
  if (investigation.cancelStatus !== "none" || job.admittedCancelEpoch !== investigation.cancelEpoch) {
    return { ok: false, reason: "investigation_cancelling" };
  }
  if (job.state !== "reserved") return { ok: false, reason: "not_claimable" };
  if (dependencyStates.some((state) => state !== "succeeded")) return { ok: false, reason: "dependencies_pending" };
  if (job.attemptsUsed >= job.maxAttempts) return { ok: false, reason: "attempts_exhausted" };
  if (
    job.pendingRevocation &&
    job.pendingRevocation.grantExpiresAtMs > now &&
    (!job.pendingRevocation.grantId || !revokedGrantIds.has(job.pendingRevocation.grantId))
  ) {
    return { ok: false, reason: "awaiting_grant_revocation" };
  }
  if (prevAttempt && prevAttempt.state === "leased" && prevAttempt.leasedUntilMs >= now) {
    return { ok: false, reason: "lease_held" };
  }
  const newEpoch = job.epoch + 1;
  const leaseExpiresAtMs = now + LEASE_EXPIRY_MS;
  const activeAttemptId = crypto.randomUUID();
  return {
    ok: true,
    newEpoch,
    attempt: { epoch: newEpoch, state: "leased", leasedUntilMs: leaseExpiresAtMs },
    job: {
      state: "grant_pending",
      epoch: newEpoch,
      activeAttemptId,
      attemptsUsed: job.attemptsUsed + 1,
      leaseExpiresAtMs,
      workerId,
      pendingRevocation: undefined,
    },
  };
}

function fenceReason(
  job: Job,
  attempt: Attempt,
  investigation: Investigation,
  epoch: number,
  now: number,
): string | undefined {
  if (attempt.epoch !== job.epoch || job.activeAttemptId !== attempt.appId || epoch !== attempt.epoch) {
    return "fenced";
  }
  if (now > attempt.leasedUntilMs) return "expired";
  if (
    job.cancelRequestedAtMs !== undefined ||
    investigation.cancelStatus !== "none" ||
    job.admittedCancelEpoch !== investigation.cancelEpoch
  ) {
    return "cancelled";
  }
  return undefined;
}

export function decideHeartbeat(
  job: Job,
  attempt: Attempt,
  investigation: Investigation,
  epoch: number,
  now: number,
  workerId?: string,
):
  | { ok: true; leasedUntilMs: number; grantExtendUntilMs: number; attemptState: "heartbeating" }
  | { ok: false; reason: string } {
  const rejected = fenceReason(job, attempt, investigation, epoch, now);
  if (rejected) return { ok: false, reason: rejected };
  if (workerId !== undefined && attempt.workerId !== workerId) return { ok: false, reason: "worker_mismatch" };
  if (["succeeded", "failed", "expired", "fenced"].includes(attempt.state)) {
    return { ok: false, reason: "terminal" };
  }
  const leasedUntilMs = now + LEASE_EXPIRY_MS;
  return { ok: true, leasedUntilMs, grantExtendUntilMs: leasedUntilMs, attemptState: "heartbeating" };
}

export function decideComplete(
  job: Job,
  attempt: Attempt,
  investigation: Investigation,
  epoch: number,
  now: number,
  outcome: "succeeded" | "failed" | "infra_failed",
  stagesPresent: readonly string[],
):
  | { ok: true; jobState: "succeeded" | "failed" | "reserved"; attemptState: "succeeded" | "failed" | "expired"; retry: boolean }
  | { ok: false; reason: string } {
  const rejected = fenceReason(job, attempt, investigation, epoch, now);
  if (rejected === "fenced") return { ok: false, reason: "stale_epoch" };
  if (rejected) return { ok: false, reason: rejected };
  if (outcome === "succeeded" && !stagesPresent.includes("evidence_committed")) {
    return { ok: false, reason: "evidence_not_committed" };
  }
  if (outcome === "succeeded") return { ok: true, jobState: "succeeded", attemptState: "succeeded", retry: false };
  if (outcome === "failed") return { ok: true, jobState: "failed", attemptState: "failed", retry: false };
  if (job.attemptsUsed < job.maxAttempts) {
    return { ok: true, jobState: "reserved", attemptState: "expired", retry: true };
  }
  return { ok: true, jobState: "failed", attemptState: "failed", retry: false };
}

export function decideExpiry(
  job: Job,
  attempt: Attempt,
  now: number,
):
  | {
      ok: true;
      attemptState: "expired";
      jobState: "reserved" | "failed";
      retry: boolean;
      pendingRevocation?: {
        attemptId: string;
        grantId?: string;
        epoch: number;
        grantExpiresAtMs: number;
      };
      releaseReservations: boolean;
    }
  | { ok: false; reason: "not_active" | "lease_live" } {
  if (job.activeAttemptId !== attempt.appId || attempt.epoch !== job.epoch) return { ok: false, reason: "not_active" };
  if (now <= attempt.leasedUntilMs) return { ok: false, reason: "lease_live" };
  if (job.attemptsUsed < job.maxAttempts) {
    return {
      ok: true,
      attemptState: "expired",
      jobState: "reserved",
      retry: true,
      pendingRevocation: {
        attemptId: attempt.appId,
        ...(attempt.grantId ? { grantId: attempt.grantId } : {}),
        epoch: attempt.epoch,
        grantExpiresAtMs: attempt.grantExpiresAtMs ?? attempt.leasedUntilMs + HARD_STOP_DEADLINE_MS,
      },
      releaseReservations: false,
    };
  }
  return { ok: true, attemptState: "expired", jobState: "failed", retry: false, releaseReservations: true };
}
