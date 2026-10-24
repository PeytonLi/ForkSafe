import type { Heartbeat } from "@forksafe/contracts";
import type { JobSource } from "./job-source.js";
import type { Lease } from "./protocol.js";

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const LEASE_TTL_MS = 30_000;

export function effectiveDeadlineMs(lease: Lease): number {
  return Math.min(lease.attempt.leasedUntilMs, lease.grant.expiresAtMs);
}

export function remainingMs(lease: Lease, now: number): number {
  return Math.max(0, effectiveDeadlineMs(lease) - now);
}

export function isExpired(lease: Lease, now: number): boolean {
  return lease.grant.revokedAtMs !== undefined || effectiveDeadlineMs(lease) <= now;
}

export function shouldAbandon(lease: Lease, now: number, marginMs = HEARTBEAT_INTERVAL_MS): boolean {
  return lease.grant.revokedAtMs !== undefined || isExpired(lease, now) || remainingMs(lease, now) < marginMs;
}

export function nextBeatAtMs(lastBeatMs: number): number {
  return lastBeatMs + HEARTBEAT_INTERVAL_MS;
}

export function missedBeats(lastAckMs: number, now: number): number {
  return Math.max(0, Math.floor((now - lastAckMs) / HEARTBEAT_INTERVAL_MS));
}

export type LeaseKeeperTimers = {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

export class LeaseKeeper {
  readonly controller = new AbortController();
  private beatTimer?: ReturnType<typeof setInterval>;
  private watchTimer?: ReturnType<typeof setInterval>;
  private lastAckMs: number;
  private beating = false;

  constructor(
    readonly lease: Lease,
    private readonly source: Pick<JobSource, "heartbeat">,
    private readonly clock: () => number = Date.now,
    private readonly timers: LeaseKeeperTimers = { setInterval, clearInterval },
  ) {
    this.lastAckMs = clock();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.beatTimer || this.controller.signal.aborted) return;
    this.beatTimer = this.timers.setInterval(() => { void this.beat(); }, HEARTBEAT_INTERVAL_MS);
    this.watchTimer = this.timers.setInterval(() => this.checkDeadline(), 1_000);
    this.checkDeadline();
  }

  stop(): void {
    if (this.beatTimer) this.timers.clearInterval(this.beatTimer);
    if (this.watchTimer) this.timers.clearInterval(this.watchTimer);
    this.beatTimer = undefined;
    this.watchTimer = undefined;
  }

  async beat(): Promise<void> {
    if (this.controller.signal.aborted || this.beating) return;
    this.beating = true;
    try {
      const response = await this.source.heartbeat({
        attemptId: this.lease.attempt.id,
        grantId: this.lease.grant.id,
        epoch: this.lease.attempt.epoch,
        atMs: this.clock(),
      } satisfies Heartbeat);
      if (!response.ok) {
        this.abort(response.reason);
        return;
      }
      if (response.epoch !== this.lease.attempt.epoch) {
        this.abort("fenced");
        return;
      }
      this.lease.attempt.leasedUntilMs = response.leasedUntilMs;
      if (response.grantExpiresAtMs !== undefined) this.lease.grant.expiresAtMs = response.grantExpiresAtMs;
      this.lastAckMs = this.clock();
      this.checkDeadline();
    } catch (error) {
      console.error(JSON.stringify({ kind: "heartbeat_failed", attemptId: this.lease.attempt.id, reason: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
      this.checkDeadline();
    } finally {
      this.beating = false;
    }
  }

  private checkDeadline(): void {
    if (this.controller.signal.aborted) return;
    if (this.lease.grant.revokedAtMs !== undefined) this.abort("revoked");
    else if (isExpired(this.lease, this.clock())) this.abort("expired");
    else if (shouldAbandon(this.lease, this.clock())) this.abort("expired");
  }

  private abort(reason: "fenced" | "expired" | "revoked" | "unknown_attempt"): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.stop();
  }
}
