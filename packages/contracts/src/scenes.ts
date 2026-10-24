export type SceneOverrideKey =
  | "cubeDx"
  | "cubeDy"
  | "targetDx"
  | "targetDy"
  | "dividerDx"
  | "dividerDy"
  | "dividerHeight"
  | "gapDx"
  | "gapWidth"
  | "speedScale";

export const TASK_FAMILY_SPECS = {
  divider_pick_place: {
    title: "Pick and place over a divider",
    description: "The robot lifts a cube over a low wall and sets it on the target.",
    baseCaseId: "original-divider-collision",
    overrideKeys: [
      "cubeDx", "cubeDy", "targetDx", "targetDy", "dividerDx", "dividerDy", "dividerHeight", "speedScale",
    ],
  },
  push_through_gap: {
    title: "Push through a gap",
    description: "The robot slides a cube through an opening in a wall to the target.",
    baseCaseId: "push-gap-aligned",
    overrideKeys: ["cubeDx", "cubeDy", "targetDx", "targetDy", "gapDx", "gapWidth", "speedScale"],
  },
} as const satisfies Record<string, {
  title: string;
  description: string;
  baseCaseId: string;
  overrideKeys: readonly SceneOverrideKey[];
}>;

export type TaskFamily = keyof typeof TASK_FAMILY_SPECS;
export const TASK_FAMILIES = Object.keys(TASK_FAMILY_SPECS) as TaskFamily[];
export const DEFAULT_TASK_FAMILY: TaskFamily = "divider_pick_place";

export function isTaskFamily(x: unknown): x is TaskFamily {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(TASK_FAMILY_SPECS, x);
}

export const SCENE_OVERRIDE_RANGES: Record<SceneOverrideKey, {
  min: number;
  max: number;
  step: number;
  label: string;
  unit: "m" | "×";
}> = {
  cubeDx: { min: -0.10, max: 0.10, step: 0.005, label: "Move cube away from robot", unit: "m" },
  cubeDy: { min: -0.10, max: 0.10, step: 0.005, label: "Move cube sideways", unit: "m" },
  targetDx: { min: -0.10, max: 0.10, step: 0.005, label: "Move target away from robot", unit: "m" },
  targetDy: { min: -0.10, max: 0.10, step: 0.005, label: "Move target sideways", unit: "m" },
  dividerDx: { min: -0.10, max: 0.10, step: 0.005, label: "Move divider away from robot", unit: "m" },
  dividerDy: { min: -0.10, max: 0.10, step: 0.005, label: "Move divider sideways", unit: "m" },
  gapDx: { min: -0.10, max: 0.10, step: 0.005, label: "Move gap along the wall", unit: "m" },
  dividerHeight: { min: 0.02, max: 0.25, step: 0.005, label: "Divider height", unit: "m" },
  gapWidth: { min: 0.05, max: 0.20, step: 0.005, label: "Gap width", unit: "m" },
  speedScale: { min: 0.5, max: 2.0, step: 0.05, label: "Robot speed", unit: "×" },
};

export function validateSceneOverrides(
  taskFamily: string,
  overrides: Record<string, number>,
): { ok: true } | { ok: false; reason: string } {
  if (!isTaskFamily(taskFamily)) return { ok: false, reason: `Unknown task "${taskFamily}".` };
  const spec = TASK_FAMILY_SPECS[taskFamily];
  for (const [key, value] of Object.entries(overrides)) {
    if (!(spec.overrideKeys as readonly string[]).includes(key)) {
      return { ok: false, reason: `${key} isn't a setting for "${spec.title}".` };
    }
    const range = SCENE_OVERRIDE_RANGES[key as SceneOverrideKey];
    if (!Number.isFinite(value)) return { ok: false, reason: `${range.label} must be a number.` };
    const epsilon = 1e-9;
    if (value < range.min - epsilon || value > range.max + epsilon) {
      const format = (n: number) => range.unit === "×" ? `${n.toFixed(2)}×` : `${n.toFixed(2)} m`;
      return { ok: false, reason: `${range.label} must be between ${format(range.min)} and ${format(range.max)}.` };
    }
  }
  return { ok: true };
}

export type SceneBaseline = {
  caseId: string;
  suite: "original" | "public" | "withheld";
  seed: number;
  sceneOverrides: Record<string, number>;
  taskFamily?: string;
  description?: string;
};

function round5(value: number): number {
  return Number(value.toFixed(5));
}

function nudgeInRange(current: number, step: number, min: number, max: number, positive: boolean): number {
  const signed = positive ? step : -step;
  const epsilon = 1e-9;
  const outside = (value: number) => value < min - epsilon || value > max + epsilon;
  let next = current + signed;
  if (outside(next)) next = current - signed;
  if (next < min) next = min;
  if (next > max) next = max;
  return round5(next);
}

/** Nearby scene for one environment. Index 0 is the captured baseline. */
export function sceneVariantFor(index: number, baseline: SceneBaseline): SceneBaseline {
  if (index <= 0) {
    return { ...baseline, sceneOverrides: { ...baseline.sceneOverrides } };
  }
  const family = isTaskFamily(baseline.taskFamily) ? baseline.taskFamily : DEFAULT_TASK_FAMILY;
  const keys = TASK_FAMILY_SPECS[family].overrideKeys;
  const key = keys[(index - 1) % keys.length]!;
  const range = SCENE_OVERRIDE_RANGES[key];
  const raw = baseline.sceneOverrides[key];
  const current = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  const value = nudgeInRange(current, range.step, range.min, range.max, index % 2 === 1);
  return {
    ...baseline,
    seed: baseline.seed + index,
    sceneOverrides: { ...baseline.sceneOverrides, [key]: value },
    description: `Environment ${index + 1} changes ${range.label}.`,
  };
}
