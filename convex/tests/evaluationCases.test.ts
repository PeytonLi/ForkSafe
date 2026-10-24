import { describe, expect, it } from "vitest";
import publicManifest from "../../evaluation/public/manifest.json";
import pushGapManifest from "../../evaluation/push_gap/manifest.json";
import { publicCasesFor, withheldApplies } from "../lib/evaluationCases.js";

describe("evaluation cases follow the investigation task", () => {
  it("keeps divider public cases on the manifest and appends a different captured scene", () => {
    const captured = {
      caseId: "original-divider-collision",
      seed: 11,
      sceneOverrides: { dividerDx: 0.01, cubeDx: -0.002 },
      taskFamily: "divider_pick_place",
      description: "Captured baseline failure",
    };
    const cases = publicCasesFor({ taskFamily: "divider_pick_place", baselineCase: captured });
    expect(cases.slice(0, -1)).toEqual(publicManifest.cases.map((item) => ({ ...item, execution: "signed" })));
    expect(cases.at(-1)).toEqual({
      caseId: "captured-baseline",
      suite: "public",
      execution: "direct",
      seed: captured.seed,
      sceneOverrides: captured.sceneOverrides,
      taskFamily: captured.taskFamily,
      description: captured.description,
    });
    const untouched = publicCasesFor({});
    expect(untouched).toEqual(publicManifest.cases.map((item) => ({ ...item, execution: "signed" })));
    expect(untouched.some((item) => item.caseId === "captured-baseline")).toBe(false);
  });

  it("does not add a captured scene that is already in the suite", () => {
    const nominal = publicManifest.cases.find((item) => item.caseId === "nominal");
    expect(nominal).toBeTruthy();
    const divider = publicCasesFor({
      taskFamily: "divider_pick_place",
      baselineCase: {
        caseId: nominal!.caseId,
        seed: nominal!.seed,
        sceneOverrides: { ...nominal!.sceneOverrides } as Record<string, number>,
      },
    });
    expect(divider.map((item) => item.caseId)).toEqual(publicManifest.cases.map((item) => item.caseId));
    expect(divider.some((item) => item.caseId === "captured-baseline")).toBe(false);
    const namedFamily = publicCasesFor({
      taskFamily: "divider_pick_place",
      baselineCase: {
        caseId: nominal!.caseId,
        seed: nominal!.seed,
        sceneOverrides: { ...nominal!.sceneOverrides } as Record<string, number>,
        taskFamily: "divider_pick_place",
      },
    });
    expect(namedFamily.some((item) => item.caseId === "captured-baseline")).toBe(false);

    const offset = pushGapManifest.cases.find((item) => item.caseId === "push-gap-offset");
    expect(offset).toBeTruthy();
    const reordered = Object.fromEntries(Object.entries(offset!.sceneOverrides).reverse()) as Record<string, number>;
    const push = publicCasesFor({
      taskFamily: "push_through_gap",
      baselineCase: {
        caseId: offset!.caseId,
        seed: offset!.seed,
        sceneOverrides: reordered,
        taskFamily: "push_through_gap",
        description: offset!.description,
      },
    });
    expect(push.map((item) => item.caseId)).toEqual(pushGapManifest.cases.map((item) => item.caseId));
    expect(push.some((item) => item.caseId === "captured-baseline")).toBe(false);

    const differentSeed = publicCasesFor({
      taskFamily: "push_through_gap",
      baselineCase: {
        caseId: offset!.caseId,
        seed: offset!.seed + 1,
        sceneOverrides: { ...offset!.sceneOverrides } as Record<string, number>,
        taskFamily: "push_through_gap",
      },
    });
    expect(differentSeed.at(-1)?.caseId).toBe("captured-baseline");
  });

  it("scores push-through-gap on the push-gap cases plus the captured scene, never signed", () => {
    const cases = publicCasesFor({
      taskFamily: "push_through_gap",
      baselineCase: {
        caseId: "push-gap-aligned",
        seed: 3,
        sceneOverrides: { gapDx: 0.02 },
        taskFamily: "push_through_gap",
        description: "Captured baseline failure",
      },
    });
    expect(cases.slice(0, -1)).toEqual(pushGapManifest.cases.map((item) => ({ ...item, execution: "direct" })));
    expect(cases.at(-1)).toEqual({
      caseId: "captured-baseline",
      suite: "public",
      execution: "direct",
      seed: 3,
      sceneOverrides: { gapDx: 0.02 },
      taskFamily: "push_through_gap",
      description: "Captured baseline failure",
    });
    expect(cases.every((item) => item.execution === "direct")).toBe(true);
    expect(cases.some((item) => item.execution === "signed")).toBe(false);
  });

  it("does not apply the divider withheld suite to push-through-gap", () => {
    expect(withheldApplies("push_through_gap")).toBe(false);
    expect(withheldApplies("divider_pick_place")).toBe(true);
    expect(withheldApplies()).toBe(true);
    expect(withheldApplies("other")).toBe(false);
  });
});
