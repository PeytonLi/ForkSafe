import { describe, expect, it } from "vitest";
import { buildRepairPrompt, controllerApiDoc } from "../src/index.js";

describe("controller API context", () => {
  it("documents toss inputs, commands, failures, and success", () => {
    const doc = controllerApiDoc("toss_into_bin");
    expect(doc).toContain("binHalfExtents");
    expect(doc).toContain("releaseAt");
    expect(doc).toContain("(0,2.0]");
    expect(doc).toContain("missed_bin_short");
    expect(doc).toContain("0.5 s");
  });

  it("selects the family from explicit params or the baseline case", () => {
    const shared = {
      investigationTitle: "robot toss",
      environmentIndex: 0,
      baselineCase: {
        caseId: "toss",
        suite: "public" as const,
        seed: 0,
        sceneOverrides: {},
      },
      failureSummary: "missed",
      findingsDigest: "",
      budgets: {},
    };
    expect(buildRepairPrompt(shared)).toContain("Task family: divider_pick_place");
    expect(
      buildRepairPrompt({
        ...shared,
        baselineCase: {
          ...shared.baselineCase,
          taskFamily: "toss_into_bin",
        },
      }),
    ).toContain("Task family: toss_into_bin");
    expect(
      buildRepairPrompt({ ...shared, taskFamily: "toss_into_bin" }),
    ).toContain("Task family: toss_into_bin");
  });
});
