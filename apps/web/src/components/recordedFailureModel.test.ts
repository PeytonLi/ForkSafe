import { describe, expect, it } from "vitest";
import { RECORDED_MODEL_LABEL, pickShrinkKey, recordedSceneFails, shrinkRecordedControl } from "./recordedFailureModel";

describe("recorded scene model", () => {
  it("uses the fixed divider and gap rules and ignores other families", () => {
    expect(RECORDED_MODEL_LABEL).toBe("This shrink uses a fixed recorded scene model, not a new MuJoCo run.");
    expect(recordedSceneFails("divider_pick_place", { dividerDx: -0.02 })).toBe(true);
    expect(recordedSceneFails("divider_pick_place", { dividerDx: -0.01999 })).toBe(false);
    expect(recordedSceneFails("divider_pick_place", { dividerDx: 0.05 })).toBe(false);
    expect(recordedSceneFails("divider_pick_place", { dividerHeight: 0.12 })).toBe(true);
    expect(recordedSceneFails("divider_pick_place", { dividerHeight: 0.11999 })).toBe(false);
    expect(recordedSceneFails("divider_pick_place", { speedScale: 1.4 })).toBe(true);
    expect(recordedSceneFails("divider_pick_place", { speedScale: 1.39999 })).toBe(false);
    expect(recordedSceneFails("divider_pick_place", { gapWidth: 0.01 })).toBe(false);
    expect(recordedSceneFails("push_through_gap", { gapWidth: 0.08 })).toBe(true);
    expect(recordedSceneFails("push_through_gap", { gapWidth: 0.08001 })).toBe(false);
    expect(recordedSceneFails("push_through_gap", { speedScale: 1.4 })).toBe(true);
    expect(recordedSceneFails("push_through_gap", { dividerDx: -0.1 })).toBe(false);
    expect(recordedSceneFails("toss_into_bin", { speedScale: 2, dividerDx: -0.1, gapWidth: 0.01 })).toBe(false);
  });

  it("picks the first control off the range midpoint", () => {
    expect(pickShrinkKey("divider_pick_place", {})).toBe("cubeDx");
    expect(pickShrinkKey("divider_pick_place", { cubeDx: 0.01, dividerHeight: 0.1, speedScale: 1.8 })).toBe("speedScale");
    expect(pickShrinkKey("divider_pick_place", { speedScale: 1.8 })).toBe("speedScale");
    expect(pickShrinkKey("push_through_gap", { gapWidth: 0.05 })).toBe("gapWidth");
  });

  it("shrinks one failing control toward the passing side without a new physics claim", () => {
    const divider = shrinkRecordedControl("divider_pick_place", { dividerDx: -0.08 }, "dividerDx");
    expect(divider).toMatchObject({ from: -0.08 });
    if (!("value" in divider)) throw new Error("expected a shrunk divider");
    expect(divider.value).toBeGreaterThan(-0.08);
    expect(divider.value).toBeLessThanOrEqual(-0.02);
    expect(recordedSceneFails("divider_pick_place", { dividerDx: divider.value })).toBe(true);

    const gap = shrinkRecordedControl("push_through_gap", { gapWidth: 0.05 }, "gapWidth");
    if (!("value" in gap)) throw new Error("expected a shrunk gap");
    expect(gap.value).toBeGreaterThan(0.05);
    expect(gap.value).toBeLessThanOrEqual(0.08);
    expect(recordedSceneFails("push_through_gap", { gapWidth: gap.value })).toBe(true);

    const speed = shrinkRecordedControl("push_through_gap", { speedScale: 1.8 }, "speedScale");
    if (!("value" in speed)) throw new Error("expected a shrunk speed");
    expect(speed.value).toBeGreaterThanOrEqual(1.4);
    expect(speed.value).toBeLessThan(1.8);

    const height = shrinkRecordedControl("divider_pick_place", { dividerHeight: 0.2 }, "dividerHeight");
    if (!("value" in height)) throw new Error("expected a shrunk divider height");
    expect(height.value).toBeGreaterThanOrEqual(0.12);
    expect(height.value).toBeLessThan(0.2);
  });

  it("does not shrink a scene the recorded model does not call a failure", () => {
    expect(shrinkRecordedControl("divider_pick_place", { dividerDx: 0.05 }, "dividerDx")).toEqual({ reason: "not-failure" });
    expect(shrinkRecordedControl("other", { speedScale: 2 }, "speedScale")).toEqual({ reason: "not-failure" });
  });

  it("does not move a control when another fixed override still fails", () => {
    expect(shrinkRecordedControl("divider_pick_place", { dividerDx: -0.08, speedScale: 2 }, "dividerDx")).toEqual({
      reason: "This recorded model has no passing value on this control, so there is nothing to shrink.",
    });
  });
});
