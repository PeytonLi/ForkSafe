import { describe, expect, it } from "vitest";
import { importedEvaluationSuites, type ImportedSuiteCase } from "../src/importedSuite.js";
import { sceneVariantFor, type SceneBaseline } from "../src/scenes.js";

function sceneKey(scene: { seed: number; sceneOverrides: Record<string, number> }): string {
  return scene.seed + JSON.stringify(scene.sceneOverrides);
}

function withheldIndex(item: ImportedSuiteCase): number {
  const match = /^imported-withheld-(\d+)$/.exec(item.caseId);
  if (!match) throw new Error(`Expected a withheld case id, got ${item.caseId}.`);
  return Number(match[1]);
}

function dividerBaseline(): SceneBaseline {
  return {
    caseId: "captured-divider",
    suite: "original",
    seed: 4,
    sceneOverrides: { dividerHeight: 0.1 },
    taskFamily: "divider_pick_place",
  };
}

function assertWithheldPastAgents(baseline: SceneBaseline, requestedEnvironments: number) {
  const { publicCases, withheldCases } = importedEvaluationSuites(baseline, requestedEnvironments);
  expect(publicCases).toEqual([{
    ...sceneVariantFor(0, baseline),
    caseId: "imported-public",
    suite: "public",
    execution: "direct",
  }]);

  const indexes = withheldCases.map(withheldIndex);
  expect(indexes).toEqual([
    requestedEnvironments,
    requestedEnvironments + 1,
    requestedEnvironments + 2,
  ]);
  for (const index of indexes) expect(index).toBeGreaterThanOrEqual(requestedEnvironments);

  const agentKeys = [0, 1, 2].map((index) => sceneKey(sceneVariantFor(index, baseline)));
  const publicKey = sceneKey(publicCases[0]!);
  for (const withheld of withheldCases) {
    const key = sceneKey(withheld);
    expect(agentKeys).not.toContain(key);
    expect(key).not.toBe(publicKey);
    expect(withheld).toEqual({
      ...sceneVariantFor(withheldIndex(withheld), baseline),
      caseId: `imported-withheld-${withheldIndex(withheld)}`,
      suite: "withheld",
      execution: "direct",
    });
  }
}

describe("importedEvaluationSuites", () => {
  it("keeps withheld divider scenes past the environments given to agents", () => {
    const baseline = dividerBaseline();
    assertWithheldPastAgents(baseline, 3);
    const { withheldCases } = importedEvaluationSuites(baseline, 3);
    for (const index of withheldCases.map(withheldIndex)) expect(index).toBeGreaterThanOrEqual(3);
  });

  it("keeps withheld push scenes past the environments given to agents", () => {
    assertWithheldPastAgents({
      caseId: "captured-push",
      suite: "original",
      seed: 4,
      sceneOverrides: { gapWidth: 0.1 },
      taskFamily: "push_through_gap",
    }, 3);
  });

  it("throws when requestedEnvironments is 0", () => {
    expect(() => importedEvaluationSuites(dividerBaseline(), 0)).toThrow(
      "requestedEnvironments must be an integer from 1 to 10.",
    );
  });
});
