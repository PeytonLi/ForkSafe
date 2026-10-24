import { TASK_FAMILY_SPECS } from "@forksafe/contracts";
import { describe, expect, it } from "vitest";
import { failureSummaryFor } from "../lib/failureBrief.js";

const FALLBACK = "The baseline run did not record a failure detail.";

describe("failureSummaryFor", () => {
  it("uses a recorded failure detail ahead of kinds and task", () => {
    const detail = "  Cube stopped short of the opening.  ";
    expect(failureSummaryFor({
      taskFamily: "push_through_gap",
      failureKinds: ["timeout", "forbidden_contact"],
      firstFailure: { kind: "timeout", tSec: 4.2, detail },
    })).toBe("Cube stopped short of the opening.");
  });

  it("names failure kinds with the task title for both families", () => {
    const pick = failureSummaryFor({
      taskFamily: "divider_pick_place",
      failureKinds: ["forbidden_contact"],
    });
    expect(pick).toBe(`The baseline run of ${TASK_FAMILY_SPECS.divider_pick_place.title} failed: forbidden_contact.`);
    expect(pick).toContain("Pick and place over a divider");

    const push = failureSummaryFor({
      taskFamily: "push_through_gap",
      failureKinds: ["timeout", "stalled"],
    });
    expect(push).toBe(`The baseline run of ${TASK_FAMILY_SPECS.push_through_gap.title} failed: timeout, stalled.`);
    expect(push).toContain("Push through a gap");
    expect(push.toLowerCase()).not.toContain("divider");
    expect(push).not.toContain("collides with the divider");
  });

  it("falls back when no failure detail was recorded", () => {
    expect(failureSummaryFor({})).toBe(FALLBACK);
    expect(failureSummaryFor({ failureKinds: [], firstFailure: null, taskFamily: "push_through_gap" })).toBe(FALLBACK);
    expect(failureSummaryFor({
      firstFailure: { kind: "timeout", tSec: 0, detail: "   " },
    })).toBe(FALLBACK);
  });

  it("truncates a long failure detail", () => {
    const detail = `wall contact ${"x".repeat(500)}`;
    const summary = failureSummaryFor({
      firstFailure: { kind: "forbidden_contact", tSec: 1.25, detail: `  ${detail}  ` },
      failureKinds: ["forbidden_contact"],
      taskFamily: "divider_pick_place",
    });
    expect(summary.length).toBe(400);
    expect(summary).toBe(detail.slice(0, 400));
    expect(summary).not.toContain("Pick and place over a divider");
  });
});
