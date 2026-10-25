import type { AgentSession } from "@forksafe/contracts";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens?: number;
  factoryCredits?: number;
  usageKnown?: boolean;
};

export type UsageLimits = { totalTokens: number; outputTokens: number };
export type ReservationSize = { total: number; output: number };
export type UsageSnapshot = {
  used: UsageLimits;
  known: UsageLimits;
  unknownTurns: number;
  partialTurns: number;
  remaining: UsageLimits;
};

type Reservation = { id: string; sessionId: string; size: ReservationSize };

/** Output is outputTokens + thinkingTokens; total is inputTokens + cacheCreationTokens + cacheReadTokens + output. */
export class BudgetExceededError extends Error {
  constructor(message = "Token budget exceeded") {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class UsageLedger {
  private readonly limits: UsageLimits;
  private readonly defaultReservation: ReservationSize;
  private readonly reservations = new Map<string, Reservation>();
  private readonly knownUsage: UsageLimits = { totalTokens: 0, outputTokens: 0 };
  private readonly chargedUsage: UsageLimits = { totalTokens: 0, outputTokens: 0 };
  private unknownTurns = 0;
  private partialTurns = 0;
  private sessionTotals = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    usageKnown: boolean;
    unknownTurns: number;
    partialTurns: number;
    factoryCredits?: number;
  }>();

  constructor(
    limits: Partial<UsageLimits> = {},
    defaultReservation: Partial<ReservationSize> = {},
  ) {
    this.limits = { totalTokens: 500_000, outputTokens: 80_000, ...limits };
    this.defaultReservation = { total: 10_000, output: 4_000, ...defaultReservation };
  }

  reserve(sessionId: string, size: ReservationSize = this.defaultReservation): string {
    const reserved = [...this.reservations.values()].reduce(
      (sum, item) => ({ total: sum.total + item.size.total, output: sum.output + item.size.output }),
      { total: 0, output: 0 },
    );
    if (
      this.chargedUsage.totalTokens + reserved.total + size.total > this.limits.totalTokens
      || this.chargedUsage.outputTokens + reserved.output + size.output > this.limits.outputTokens
    ) throw new BudgetExceededError();
    const id = crypto.randomUUID();
    this.reservations.set(id, { id, sessionId, size: { ...size } });
    return id;
  }

  settle(reservationId: string, usage: TokenUsage | null): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`Unknown usage reservation: ${reservationId}`);
    this.reservations.delete(reservationId);
    let totals = this.sessionTotals.get(reservation.sessionId);
    if (!totals) {
      totals = {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        usageKnown: true, unknownTurns: 0, partialTurns: 0,
      };
      this.sessionTotals.set(reservation.sessionId, totals);
    }
    if (usage === null) {
      this.chargedUsage.totalTokens += reservation.size.total;
      this.chargedUsage.outputTokens += reservation.size.output;
      this.unknownTurns += 1;
      totals.usageKnown = false;
      totals.unknownTurns += 1;
      return;
    }
    const output = usage.outputTokens + (usage.thinkingTokens ?? 0);
    const total = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + output;
    this.chargedUsage.totalTokens += total;
    this.chargedUsage.outputTokens += output;
    this.knownUsage.totalTokens += total;
    this.knownUsage.outputTokens += output;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += output;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheCreationTokens += usage.cacheCreationTokens;
    if (usage.usageKnown === false) {
      this.partialTurns += 1;
      totals.partialTurns += 1;
      totals.usageKnown = false;
    }
    if (usage.factoryCredits !== undefined) totals.factoryCredits = (totals.factoryCredits ?? 0) + usage.factoryCredits;
  }

  release(reservationId: string): void {
    if (!this.reservations.delete(reservationId)) throw new Error(`Unknown usage reservation: ${reservationId}`);
  }

  snapshot(): UsageSnapshot {
    const outstanding = [...this.reservations.values()].reduce(
      (sum, item) => ({ total: sum.total + item.size.total, output: sum.output + item.size.output }),
      { total: 0, output: 0 },
    );
    const used = {
      totalTokens: this.chargedUsage.totalTokens + outstanding.total,
      outputTokens: this.chargedUsage.outputTokens + outstanding.output,
    };
    return {
      used,
      known: { ...this.knownUsage },
      unknownTurns: this.unknownTurns,
      partialTurns: this.partialTurns,
      remaining: {
        totalTokens: Math.max(0, this.limits.totalTokens - used.totalTokens),
        outputTokens: Math.max(0, this.limits.outputTokens - used.outputTokens),
      },
    };
  }

  sessionUsage(sessionId: string): AgentSession["tokenUsage"] {
    const totals = this.sessionTotals.get(sessionId);
    return {
      inputTokens: totals?.inputTokens ?? 0,
      outputTokens: totals?.outputTokens ?? 0,
      cacheReadTokens: totals?.cacheReadTokens ?? 0,
      cacheCreationTokens: totals?.cacheCreationTokens ?? 0,
      usageKnown: totals?.usageKnown ?? true,
      ...(totals?.factoryCredits !== undefined ? { factoryCredits: totals.factoryCredits } : {}),
    };
  }

  sessionUsageCounts(sessionId: string): { unknownTurns: number; partialTurns: number } {
    const totals = this.sessionTotals.get(sessionId);
    return { unknownTurns: totals?.unknownTurns ?? 0, partialTurns: totals?.partialTurns ?? 0 };
  }
}
