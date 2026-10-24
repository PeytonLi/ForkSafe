import { describe, expect, it } from "vitest";
import { outcomeSentence, plainOutcome } from "./learning";

describe("plain learning outcomes", () => {
  it("describes completion and divider collisions without replay controls", () => {
    expect(plainOutcome({ completed: true, completionTimeSec: 7.1, failureKinds: [] })).toBe("placed the cube in 7.1 s");
    expect(plainOutcome({
      completed: false,
      firstFailure: { kind: "forbidden_contact", tSec: 4.1, detail: "cube touched divider" },
      failureKinds: ["forbidden_contact"],
    })).toBe("hit the divider at 4.1 s");
  });

  it("uses a plain-language fallback for other failures", () => {
    expect(plainOutcome({
      completed: false,
      firstFailure: { kind: "joint_limit", tSec: 2, detail: "limit" },
      failureKinds: ["joint_limit"],
    })).toBe("joint limit at 2.0 s");
    expect(plainOutcome({ completed: false, failureKinds: [] })).toBe("did not finish");
    expect(outcomeSentence(
      { completed: false, firstFailure: { kind: "forbidden_contact", tSec: 4.1, detail: "divider" }, failureKinds: [] },
      { completed: true, completionTimeSec: 7.1, failureKinds: [] },
    )).toBe("Before: hit the divider at 4.1 s. After: placed the cube in 7.1 s.");
  });
});
