import {
  TASK_FAMILY_SPECS,
  validateSceneOverrides,
  type TaskFamily,
} from "@forksafe/contracts";

export interface FuzzGrid {
  samples?: Array<{
    passed?: boolean;
    failureKind?: string | null;
    sceneOverrides?: Record<string, number>;
    seed?: number;
  }>;
  n?: number;
  summary?: { failCount?: number };
}

export const FIND_FAILURE_BUDGET = {
  sandboxReadyMs: 75_000,
  bundleFetchSec: 45,
  bundleExtractSec: 20,
  bundleDepsSec: 30,
  bundlePreflightSec: 15,
  bundleSec: 139,
  manifestCheckSec: 15,
  controllerUploadSec: 20,
  fuzzSamples: 16,
  fuzzWorkers: 2,
  fuzzCaseTimeoutSec: 30,
  fuzzMarginSec: 30,
  fuzzExecSec: 270,
  pullSec: 20,
} as const;

export function findFailureWorstCaseSec(): number {
  return FIND_FAILURE_BUDGET.sandboxReadyMs / 1000
    + FIND_FAILURE_BUDGET.bundleSec
    + FIND_FAILURE_BUDGET.manifestCheckSec
    + FIND_FAILURE_BUDGET.controllerUploadSec
    + FIND_FAILURE_BUDGET.fuzzExecSec
    + FIND_FAILURE_BUDGET.pullSec;
}

export type FailureSearchResult =
  | { mode: "live"; found: true; taskFamily: TaskFamily; caseId: string; sceneOverrides: Record<string, number>; seed: number; samples: number; failures: number; failureKind?: string }
  | { mode: "live"; found: false; samples: number; failures: number; reason: string };

export function pickFirstFailure(
  grid: FuzzGrid,
  family: TaskFamily,
  seed = 1,
): FailureSearchResult {
  const samples = Array.isArray(grid.samples) ? grid.samples : [];
  const failures = Number.isFinite(grid.summary?.failCount)
    ? grid.summary!.failCount!
    : samples.filter((sample) => sample.passed === false).length;

  for (const sample of samples) {
    if (sample.passed !== false || sample.failureKind === "invalid_run" || !sample.sceneOverrides) continue;
    const sceneOverrides = Object.fromEntries(
      Object.entries(sample.sceneOverrides).map(([key, value]) => [key, Math.round(value * 100_000) / 100_000]),
    );
    if (!validateSceneOverrides(family, sceneOverrides).ok) continue;
    return {
      mode: "live",
      found: true,
      taskFamily: family,
      caseId: TASK_FAMILY_SPECS[family].baseCaseId,
      sceneOverrides,
      seed: Number.isFinite(sample.seed) ? sample.seed! : seed,
      samples: Number.isFinite(grid.n) ? grid.n! : samples.length,
      failures,
      ...(sample.failureKind ? { failureKind: sample.failureKind } : {}),
    };
  }

  return {
    mode: "live",
    found: false,
    samples: Number.isFinite(grid.n) ? grid.n! : samples.length,
    failures,
    reason: "No valid failing scene was found in this search.",
  };
}
