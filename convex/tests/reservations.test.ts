import { describe, expect, it } from "vitest";
import { countsTowardCapacity, decideModelTurnReserve, decideReserve } from "../lib/reservations.js";

describe("capacity decisions", () => {
  it("counts retained ambiguous sandboxes toward the cap", () => {
    const rows = ["active", "active", "retained_ambiguous", "retained_ambiguous", "active"] as const;
    const count = rows.filter(countsTowardCapacity).length;
    expect(count).toBe(5);
    expect(decideReserve("sandbox", count, 5)).toMatchObject({ ok: false });
  });
  it("enforces global four-turn and one-turn-per-session caps", () => {
    expect(decideModelTurnReserve(3, 0, 4, 1)).toMatchObject({ ok: true });
    expect(decideModelTurnReserve(3, 1, 4, 1)).toMatchObject({ ok: false, reason: "session_capacity_exhausted" });
    expect(decideModelTurnReserve(4, 0, 4, 1)).toMatchObject({ ok: false, reason: "global_capacity_exhausted" });
  });
});
