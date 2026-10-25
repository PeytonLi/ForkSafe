import { sceneVariantFor, type SceneBaseline } from "./scenes.js";

export type ImportedSuiteCase = SceneBaseline & { suite: "public" | "withheld"; execution: "direct" };

export function importedEvaluationSuites(
  baseline: SceneBaseline,
  requestedEnvironments: number,
): { publicCases: ImportedSuiteCase[]; withheldCases: ImportedSuiteCase[] } {
  if (!Number.isInteger(requestedEnvironments) || requestedEnvironments < 1 || requestedEnvironments > 10) {
    throw new Error("requestedEnvironments must be an integer from 1 to 10.");
  }

  const publicCases: ImportedSuiteCase[] = [{
    ...sceneVariantFor(0, baseline),
    caseId: "imported-public",
    suite: "public",
    execution: "direct",
  }];

  const withheldCases = [0, 1, 2].map((offset): ImportedSuiteCase => {
    const index = requestedEnvironments + offset;
    return {
      ...sceneVariantFor(index, baseline),
      caseId: `imported-withheld-${index}`,
      suite: "withheld",
      execution: "direct",
    };
  });

  return { publicCases, withheldCases };
}
