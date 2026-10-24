import { describe, expect, it } from "vitest";
import { decideClaim, decideComplete, decideExpiry, decideHeartbeat } from "../lib/leasing.js";

const investigation = { cancelStatus: "none" as const, cancelEpoch: 0 };
const flags = { admissionPaused: false };
const job = {
  appId: "job", state: "reserved", epoch: 0, attemptsUsed: 0, maxAttempts: 2,
  admittedCancelEpoch: 0,
};
const attempt = {
  appId: "attempt", epoch: 1, state: "leased", workerId: "worker",
  leasedUntilMs: 30_000, startedAtMs: 0,
};

describe("leasing decisions", () => {
  it("claims once and rejects cancelled or leased jobs", () => {
    expect(decideClaim(job, null, investigation, flags, 0, "worker")).toMatchObject({ ok: true, newEpoch: 1 });
    expect(decideClaim(job, attempt, investigation, flags, 10, "other")).toMatchObject({ ok: false, reason: "lease_held" });
    expect(decideClaim(job, null, { ...investigation, cancelStatus: "cancel_requested" }, flags, 0, "worker"))
      .toMatchObject({ ok: false, reason: "investigation_cancelling" });
  });
  it("extends heartbeat only for the matching worker, attempt, and epoch", () => {
    const running = { ...job, state: "running", epoch: 1, activeAttemptId: "attempt" };
    expect(decideHeartbeat(running, attempt, investigation, 1, 1_000, "worker")).toMatchObject({ ok: true, leasedUntilMs: 31_000 });
    expect(decideHeartbeat(running, attempt, investigation, 1, 1_000, "other")).toMatchObject({ ok: false, reason: "worker_mismatch" });
    expect(decideHeartbeat(running, attempt, investigation, 2, 1_000, "worker")).toMatchObject({ ok: false, reason: "fenced" });
  });
  it("retries one expired lease, then fails and fences stale completion", () => {
    const first = decideExpiry({ ...job, state: "running", epoch: 1, activeAttemptId: "attempt", attemptsUsed: 1 }, attempt, 31_000);
    expect(first).toMatchObject({ ok: true, retry: true, jobState: "reserved", pendingRevocation: { attemptId: "attempt" } });
    const second = decideExpiry({ ...job, state: "running", epoch: 2, activeAttemptId: "attempt-2", attemptsUsed: 2 }, { ...attempt, appId: "attempt-2", epoch: 2 }, 31_000);
    expect(second).toMatchObject({ ok: true, retry: false, jobState: "failed", releaseReservations: true });
    expect(decideComplete({ ...job, epoch: 2, activeAttemptId: "attempt-2" }, attempt, investigation, 1, 1_000, "succeeded", []))
      .toMatchObject({ ok: false, reason: "stale_epoch" });
  });
  it("blocks a new claim until pending grant revocation is safe", () => {
    expect(decideClaim({
      ...job, pendingRevocation: { attemptId: "attempt", epoch: 1, grantExpiresAtMs: 40_000 },
    }, null, investigation, flags, 10_000, "worker")).toMatchObject({ ok: false, reason: "awaiting_grant_revocation" });
    expect(decideClaim({
      ...job, pendingRevocation: { attemptId: "attempt", epoch: 1, grantExpiresAtMs: 40_000 },
    }, null, investigation, flags, 10_000, "worker", [], new Set())).toMatchObject({ ok: false });
    expect(decideHeartbeat({ ...job, state: "running", epoch: 1, activeAttemptId: "attempt", cancelRequestedAtMs: 1 }, attempt, investigation, 1, 1_000, "worker"))
      .toMatchObject({ ok: false, reason: "cancelled" });
  });
});
