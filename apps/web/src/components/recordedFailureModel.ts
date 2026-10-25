import { minimizeMonotonic, SCENE_OVERRIDE_RANGES, TASK_FAMILY_SPECS, isTaskFamily, type SceneOverrideKey, type TaskFamily } from "@forksafe/contracts";

/** Shown on the shrink control. This model is a fixed rule, not a new MuJoCo run. */
export const RECORDED_MODEL_LABEL = "This shrink uses a fixed recorded scene model, not a new MuJoCo run.";

/**
 * Fixed recorded scene model used only to shrink a failure the scene already shows.
 * divider_pick_place fails when dividerDx <= -0.02 (the divider moved at least 2 cm
 * toward the robot; positive dividerDx is away), dividerHeight >= 0.12, or speedScale >= 1.4.
 * push_through_gap fails when gapWidth <= 0.08 or speedScale >= 1.4.
 * Any other task family does not fail.
 */
export function recordedSceneFails(taskFamily: string, overrides: Record<string, number>): boolean {
  const speedFails = atLeast(overrides, "speedScale", 1.4);
  if (taskFamily === "divider_pick_place") {
    return atMost(overrides, "dividerDx", -0.02) || atLeast(overrides, "dividerHeight", 0.12) || speedFails;
  }
  if (taskFamily === "push_through_gap") {
    return atMost(overrides, "gapWidth", 0.08) || speedFails;
  }
  return false;
}

function atLeast(overrides: Record<string, number>, key: string, limit: number): boolean {
  const value = overrides[key];
  return typeof value === "number" && Number.isFinite(value) && value >= limit;
}

function atMost(overrides: Record<string, number>, key: string, limit: number): boolean {
  const value = overrides[key];
  return typeof value === "number" && Number.isFinite(value) && value <= limit;
}

function midpoint(key: SceneOverrideKey): number {
  const range = SCENE_OVERRIDE_RANGES[key];
  return (range.min + range.max) / 2;
}

/** A control that is actually making the recorded model fail, otherwise the family's first override. */
export function pickShrinkKey(taskFamily: TaskFamily, overrides: Record<string, number>): SceneOverrideKey {
  const keys = TASK_FAMILY_SPECS[taskFamily].overrideKeys;
  for (const key of keys) {
    const range = SCENE_OVERRIDE_RANGES[key];
    const passesAtEnd = !recordedSceneFails(taskFamily, { ...overrides, [key]: range.min })
      || !recordedSceneFails(taskFamily, { ...overrides, [key]: range.max });
    if (recordedSceneFails(taskFamily, overrides) && passesAtEnd) return key;
  }
  return keys[0];
}

export function shrinkRecordedControl(
  taskFamily: string,
  overrides: Record<string, number>,
  key: string,
): { value: number; from: number } | { reason: string } {
  if (!recordedSceneFails(taskFamily, overrides)) return { reason: "not-failure" };
  if (!isTaskFamily(taskFamily) || !isSceneKey(key)) return { reason: "This control is not in the recorded model." };
  const range = SCENE_OVERRIDE_RANGES[key];
  const raw = overrides[key];
  const high = typeof raw === "number" && Number.isFinite(raw) ? raw : midpoint(key);
  const fails = (value: number) => recordedSceneFails(taskFamily, { ...overrides, [key]: value });
  const minPasses = !fails(range.min);
  const maxPasses = !fails(range.max);
  if (!minPasses && !maxPasses) {
    return { reason: "This recorded model has no passing value on this control, so there is nothing to shrink." };
  }
  const passing = minPasses ? range.min : range.max;
  if (passing <= high) {
    const result = minimizeMonotonic({ low: passing, high, fails });
    if ("reason" in result) return result;
    return { value: result.value, from: high };
  }
  const result = minimizeMonotonic({
    low: -passing,
    high: -high,
    fails: (value) => fails(-value),
  });
  if ("reason" in result) return result;
  return { value: Number((-result.value).toFixed(5)), from: high };
}

function isSceneKey(key: string): key is SceneOverrideKey {
  return Object.prototype.hasOwnProperty.call(SCENE_OVERRIDE_RANGES, key);
}
