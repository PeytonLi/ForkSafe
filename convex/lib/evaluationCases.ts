import publicManifest from "../../evaluation/public/manifest.json";
import withheldManifest from "../../evaluation/withheld/manifest.json";
import pushGapManifest from "../../evaluation/push_gap/manifest.json";
import { importedEvaluationSuites, type ImportedSuiteCase } from "../../packages/contracts/src/importedSuite.js";

export type EvaluationCase = {
  caseId: string;
  suite: "public" | "withheld" | "original";
  seed: number;
  sceneOverrides: Record<string, number>;
  taskFamily?: string;
  description?: string;
  execution: "signed" | "direct";
};

type RawCase = {
  caseId: string;
  suite: EvaluationCase["suite"];
  seed: number;
  sceneOverrides?: Record<string, number>;
  taskFamily?: string;
  description?: string;
};

type BaselineCase = {
  caseId: string;
  seed: number;
  sceneOverrides: Record<string, number>;
  taskFamily?: string;
  description?: string;
  suite?: "original" | "public" | "withheld";
};

type CaseSelection = {
  taskFamily?: string;
  baselineCase?: BaselineCase;
  controllerChoice?: string;
  requestedEnvironments?: number;
};

const dividerWithheldCases = (withheldManifest as { cases: RawCase[] }).cases;

function materialize(cases: RawCase[], execution: EvaluationCase["execution"], taskFamily?: string): EvaluationCase[] {
  return cases.map((item) => ({
    caseId: item.caseId,
    suite: item.suite,
    seed: item.seed,
    sceneOverrides: item.sceneOverrides ?? {},
    execution,
    ...((taskFamily ?? item.taskFamily) ? { taskFamily: taskFamily ?? item.taskFamily } : {}),
    ...(item.description ? { description: item.description } : {}),
  }));
}

function sameOverrides(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

/** Manifest cases omit taskFamily. A captured divider baseline still names it. */
function sameFamily(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "divider_pick_place") === (right ?? "divider_pick_place");
}

function toDirectCase(item: ImportedSuiteCase): EvaluationCase {
  return {
    caseId: item.caseId,
    suite: item.suite,
    seed: item.seed,
    sceneOverrides: item.sceneOverrides,
    execution: "direct",
    ...(item.taskFamily ? { taskFamily: item.taskFamily } : {}),
    ...(item.description ? { description: item.description } : {}),
  };
}

function importedSuites(investigation: CaseSelection): { publicCases: EvaluationCase[]; withheldCases: EvaluationCase[] } | undefined {
  const baseline = investigation.baselineCase;
  if (investigation.controllerChoice !== "imported" || !baseline) return undefined;
  const taskFamily = baseline.taskFamily ?? investigation.taskFamily;
  const suites = importedEvaluationSuites({
    caseId: baseline.caseId,
    suite: baseline.suite ?? "original",
    seed: baseline.seed,
    sceneOverrides: baseline.sceneOverrides,
    ...(taskFamily ? { taskFamily } : {}),
    ...(baseline.description ? { description: baseline.description } : {}),
  }, investigation.requestedEnvironments ?? 1);
  return {
    publicCases: suites.publicCases.map(toDirectCase),
    withheldCases: suites.withheldCases.map(toDirectCase),
  };
}

/** Public cases for the task the investigation actually built.
 *  Divider stays on the signed public manifest. Push-gap and the captured
 *  scene cannot go through the manifest-locked signed evaluator.
 *  An imported controller is scored on the imported scene. */
export function publicCasesFor(investigation: CaseSelection): EvaluationCase[] {
  const imported = importedSuites(investigation);
  if (imported) return imported.publicCases;
  const cases = investigation.taskFamily === "push_through_gap"
    ? materialize((pushGapManifest as { cases: RawCase[] }).cases, "direct", "push_through_gap")
    : materialize((publicManifest as { cases: RawCase[] }).cases, "signed");
  const baseline = investigation.baselineCase;
  if (!baseline) return cases;
  const duplicate = cases.some((item) =>
    sameFamily(item.taskFamily, baseline.taskFamily)
    && item.seed === baseline.seed
    && sameOverrides(item.sceneOverrides, baseline.sceneOverrides));
  if (duplicate) return cases;
  return [...cases, {
    caseId: "captured-baseline",
    suite: "public",
    seed: baseline.seed,
    sceneOverrides: baseline.sceneOverrides,
    execution: "direct",
    ...(baseline.taskFamily ? { taskFamily: baseline.taskFamily } : {}),
    ...(baseline.description ? { description: baseline.description } : {}),
  }];
}

/** Divider withheld manifest, or imported variations past the scenes given to agents.
 *  Stock push-through-gap has no withheld suite. */
export function withheldCasesFor(investigation: CaseSelection): EvaluationCase[] {
  const imported = importedSuites(investigation);
  if (imported) return imported.withheldCases;
  if (investigation.taskFamily === "push_through_gap") return [];
  return materialize(dividerWithheldCases, "signed");
}

/** Push-through-gap has no withheld suite. Do not grade it on divider withheld cases.
 *  Imported controllers still withhold variations of their own scene, including push. */
export function withheldApplies(input?: string | CaseSelection): boolean {
  if (typeof input === "object" && input) {
    if (input.controllerChoice === "imported") return true;
    return withheldApplies(input.taskFamily);
  }
  const divider = input === undefined || input === "divider_pick_place";
  return divider && dividerWithheldCases.length > 0;
}
