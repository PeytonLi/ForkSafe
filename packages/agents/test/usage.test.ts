import { describe, expect, it } from "vitest";
import { AgentSession } from "@forksafe/contracts";
import { BudgetExceededError, UsageLedger } from "../src/usage.js";

describe("UsageLedger", () => {
  it("accounts output and total using Factory usage fields", () => {
    const ledger = new UsageLedger({ totalTokens: 100, outputTokens: 30 }, { total: 30, output: 10 });
    const reservation = ledger.reserve("session");
    ledger.settle(reservation, { inputTokens: 20, outputTokens: 10, thinkingTokens: 5, cacheCreationTokens: 2, cacheReadTokens: 3 });
    expect(ledger.snapshot()).toMatchObject({ used: { totalTokens: 40, outputTokens: 15 }, known: { totalTokens: 40, outputTokens: 15 } });
  });

  it("enforces output and total limits independently", () => {
    const output = new UsageLedger({ totalTokens: 100, outputTokens: 10 }, { total: 20, output: 6 });
    output.reserve("a");
    expect(() => output.reserve("b", { total: 10, output: 5 })).toThrow(BudgetExceededError);
    const total = new UsageLedger({ totalTokens: 10, outputTokens: 100 }, { total: 8, output: 1 });
    total.reserve("a");
    expect(() => total.reserve("b", { total: 3, output: 1 })).toThrow(BudgetExceededError);
  });

  it("keeps unknown usage charged and reports it as unknown, not zero", () => {
    const ledger = new UsageLedger({}, { total: 10, output: 4 });
    ledger.settle(ledger.reserve("session"), null);
    expect(ledger.snapshot()).toMatchObject({
      used: { totalTokens: 10, outputTokens: 4 },
      unknownTurns: 1,
    });
    expect(ledger.sessionUsage("session").usageKnown).toBe(false);
    expect(ledger.sessionUsage("session")).toMatchObject({
      inputTokens: 0, outputTokens: 0, usageKnown: false,
    });
    expect(ledger.sessionUsageCounts("session")).toEqual({ unknownTurns: 1, partialTurns: 0 });
  });

  it("releases unused reservations and returns contract-compatible session usage", () => {
    const ledger = new UsageLedger();
    const reservation = ledger.reserve("session", { total: 10, output: 2 });
    ledger.release(reservation);
    expect(ledger.snapshot().used.totalTokens).toBe(0);
    ledger.settle(ledger.reserve("session"), {
      inputTokens: 3, outputTokens: 2, cacheCreationTokens: 1, cacheReadTokens: 4, factoryCredits: 0.5,
    });
    expect(AgentSession.shape.tokenUsage.parse(ledger.sessionUsage("session"))).toMatchObject({
      inputTokens: 3, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 1,
      usageKnown: true, factoryCredits: 0.5,
    });
  });
});
