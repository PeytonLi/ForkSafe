import { describe, expect, it } from "vitest";
import { mayWrite, seatAllows } from "./browserAccess";

describe("browser write gating", () => {
  it("requires a session in convex mode but leaves fixtures unchanged", () => {
    expect(mayWrite("convex", false)).toBe(false);
    expect(mayWrite("convex", true)).toBe(true);
    expect(mayWrite("convex", true, false)).toBe(false);
    expect(mayWrite("fixture", false)).toBe(true);
  });

  it("lets a lead do both, an operator run the work, and a reviewer only review", () => {
    expect(seatAllows("lead", "operate")).toBe(true);
    expect(seatAllows("lead", "review")).toBe(true);
    expect(seatAllows("operator", "operate")).toBe(true);
    expect(seatAllows("operator", "review")).toBe(false);
    expect(seatAllows("reviewer", "operate")).toBe(false);
    expect(seatAllows("reviewer", "review")).toBe(true);
  });
});
