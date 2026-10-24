import { describe, expect, it } from "vitest";
import { captureProgressFor } from "./captureProgress";

describe("capture progress mapping", () => {
  it("highlights queued and recording steps", () => {
    expect(captureProgressFor({ captureStatus: "pending", investigationState: "capturing" })).toMatchObject({
      activeStep: 0,
      currentTitle: "Queued",
    });
    expect(captureProgressFor({ captureStatus: "running", investigationState: "capturing" })).toMatchObject({
      activeStep: 1,
      currentTitle: "Recording the robot",
    });
  });

  it("reports expected failures and unexpected successes", () => {
    expect(captureProgressFor({
      captureStatus: "recorded",
      baselineStatus: "physics_failure",
      investigationState: "capturing",
    })).toMatchObject({
      activeStep: 2,
      currentTitle: "Failed as expected",
      currentDetail: "The robot failed in this scene, so agents have something to fix.",
    });
    expect(captureProgressFor({
      captureStatus: "recorded",
      baselineStatus: "succeeded",
      investigationState: "capturing",
    })).toMatchObject({
      activeStep: 2,
      currentTitle: "Passed unexpectedly",
      currentDetail: "The robot finished without failing, so this scene doesn't show the problem. Try changing the scene.",
    });
  });

  it("shows the plain capture error and advances the agent step", () => {
    expect(captureProgressFor({
      captureStatus: "failed",
      investigationState: "failed",
      lastError: "baseline_engine_error",
    })).toMatchObject({
      activeStep: 2,
      currentTitle: "Recording didn't work",
      currentDetail: "baseline_engine_error",
    });
    expect(captureProgressFor({
      captureStatus: "recorded",
      baselineStatus: "constraint_violation",
      investigationState: "admitted",
    })).toMatchObject({
      activeStep: 3,
      currentTitle: "Agents starting",
      resultTitle: "Failed as expected",
    });
    expect(captureProgressFor({
      captureStatus: "recorded",
      baselineStatus: "succeeded",
      investigationState: "searching",
    })).toMatchObject({ activeStep: 3, currentTitle: "Agents working" });
    expect(captureProgressFor({
      captureStatus: "recorded",
      baselineStatus: "physics_failure",
      investigationState: "evaluating",
    })).toMatchObject({ activeStep: 3, currentTitle: "Agents working" });
  });
});
