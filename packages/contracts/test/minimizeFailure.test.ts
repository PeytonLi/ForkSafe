import { describe, expect, it } from "vitest";
import { minimizeMonotonic } from "../src/minimizeFailure.js";

describe("minimizeMonotonic", () => {
  it("finds the smallest failing value on the boundary", () => {
    expect(minimizeMonotonic({
      low: 0,
      high: 1,
      fails: (value) => value >= 0.5,
    })).toEqual({ value: 0.5, steps: 12 });
  });

  it("stays on the failing side and rounds to 5 decimals", () => {
    const result = minimizeMonotonic({
      low: -0.1,
      high: 0.1,
      fails: (value) => value >= 0.03,
    });
    expect(result).toMatchObject({ steps: 12 });
    if (!("value" in result)) throw new Error("expected a boundary value");
    expect(result.value).toBeGreaterThanOrEqual(0.03);
    expect(result.value).toBeLessThan(0.03 + 0.2 / 2 ** 12 + 1e-5);
    expect(result.value).toBe(Number(result.value.toFixed(5)));
    expect(result.value >= 0.03).toBe(true);
  });

  it("returns a reason when the low value already fails", () => {
    expect(minimizeMonotonic({
      low: 0.2,
      high: 1,
      fails: (value) => value >= 0.2,
    })).toEqual({ reason: "The low value already fails." });
  });

  it("returns a reason when the high value does not fail", () => {
    expect(minimizeMonotonic({
      low: 0,
      high: 0.4,
      fails: (value) => value >= 0.5,
    })).toEqual({ reason: "The high value does not fail." });
  });

  it("rejects non-finite bounds before calling fails", () => {
    expect(minimizeMonotonic({
      low: Number.NaN,
      high: 1,
      fails: () => {
        throw new Error("fails should not run");
      },
    })).toEqual({ reason: "Search bounds must be finite numbers." });
  });

  it("uses the requested iteration count", () => {
    expect(minimizeMonotonic({
      low: 0,
      high: 0.123456789,
      fails: (value) => value >= 0.1,
      iterations: 0,
    })).toEqual({ value: 0.12346, steps: 0 });
  });
});
