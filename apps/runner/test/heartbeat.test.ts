import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_INTERVAL_MS, LeaseKeeper, effectiveDeadlineMs, isExpired, missedBeats, nextBeatAtMs, remainingMs, shouldAbandon } from "../src/heartbeat.js";
import { sampleLease } from "./helpers.js";

afterEach(() => vi.useRealTimers());

describe("lease heartbeat", () => {
  it("uses the earliest deadline and handles boundary math", () => {
    const lease = sampleLease(1_000);
    lease.attempt.leasedUntilMs = 9_000;
    lease.grant.expiresAtMs = 8_000;
    expect(effectiveDeadlineMs(lease)).toBe(8_000);
    expect(remainingMs(lease, 7_000)).toBe(1_000);
    expect(isExpired(lease, 8_000)).toBe(true);
    expect(nextBeatAtMs(1_000)).toBe(1_000 + HEARTBEAT_INTERVAL_MS);
    expect(missedBeats(1_000, 11_000)).toBe(2);
  });

  it("abandons revoked, expired, and near-deadline leases", () => {
    const lease = sampleLease(1_000);
    expect(shouldAbandon(lease, 26_001)).toBe(true);
    expect(shouldAbandon(lease, 31_000)).toBe(true);
    lease.grant.revokedAtMs = 2_000;
    expect(shouldAbandon(lease, 2_000)).toBe(true);
  });

  it("extends only the attempt lease when a heartbeat omits grant expiry and aborts on fencing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const lease = sampleLease(10_000);
    const source = { heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: 50_000, epoch: 0 })) };
    const keeper = new LeaseKeeper(lease, source);
    keeper.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(source.heartbeat).toHaveBeenCalledTimes(1);
    expect(lease.attempt.leasedUntilMs).toBe(50_000);
    expect(lease.grant.expiresAtMs).toBe(40_000);
    keeper.stop();

    const fenced = new LeaseKeeper(sampleLease(10_000), {
      heartbeat: async () => ({ ok: false as const, reason: "fenced" as const }),
    });
    fenced.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fenced.signal.aborted).toBe(true);
    expect(fenced.signal.reason).toBe("fenced");
  });

  it("abandons as the unchanged grant expiry approaches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const lease = sampleLease(10_000);
    const keeper = new LeaseKeeper(lease, {
      heartbeat: async () => ({ ok: true as const, leasedUntilMs: 50_000, epoch: 0 }),
    });
    keeper.start();
    await vi.advanceTimersByTimeAsync(26_000);
    expect(lease.attempt.leasedUntilMs).toBe(50_000);
    expect(lease.grant.expiresAtMs).toBe(40_000);
    expect(keeper.signal.aborted).toBe(true);
    expect(keeper.signal.reason).toBe("expired");
  });

  it("aborts as repeated network failures approach the lease deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const keeper = new LeaseKeeper(sampleLease(10_000), { heartbeat: async () => { throw new Error("offline"); } });
    keeper.start();
    await vi.advanceTimersByTimeAsync(26_000);
    expect(keeper.signal.aborted).toBe(true);
    expect(keeper.signal.reason).toBe("expired");
  });
});
