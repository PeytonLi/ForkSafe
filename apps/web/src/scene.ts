import {
  DEFAULT_TASK_FAMILY,
  TASK_FAMILY_SPECS,
  isTaskFamily,
  TOSS_BIN_DEFAULTS,
  validateSceneOverrides,
  type SceneOverrideKey,
  type TaskFamily,
} from "@forksafe/contracts";

export const BASE_SCENES = {
  divider_pick_place: {
    cubeStart: [0.5, -0.15, 0.02],
    target: [0.5, 0.15, 0.02],
    dividerCenter: [0.5, 0],
    dividerHalfLength: 0.1,
    dividerHalfThickness: 0.01,
    dividerHeight: 0.1,
  },
  push_through_gap: {
    cubeStart: [0.5, -0.15, 0.02],
    target: [0.5, 0.15, 0.02],
    gapCenter: [0.5, 0],
    gapWidth: 0.07,
    wallHalfThickness: 0.01,
    wallHeight: 0.04,
    wallSpanX: [0.2, 0.9],
  },
  bin_drop: {
    cubeStart: [0.42, -0.22, 0.02],
    target: [0.62, 0.16, 0.02],
    binCenter: [0.62, 0.16],
    binWidth: 0.14,
  },
  toss_into_bin: {
    cubeStart: TOSS_BIN_DEFAULTS.objectStart,
    target: [0.95, 0, 0.01],
    binCenter: TOSS_BIN_DEFAULTS.binCenter,
    binWallHeight: TOSS_BIN_DEFAULTS.binWallHeight,
  },
} as const;

export type DividerScene = {
  kind: "divider_pick_place";
  cubeStart: [number, number, number];
  target: [number, number, number];
  dividerCenter: [number, number];
  dividerHalfLength: number;
  dividerHalfThickness: number;
  dividerHeight: number;
  speedScale: number;
};

export type PushGapScene = {
  kind: "push_through_gap";
  cubeStart: [number, number, number];
  target: [number, number, number];
  gapCenter: [number, number];
  gapWidth: number;
  wallHalfThickness: number;
  wallHeight: number;
  wallSpanX: [number, number];
  speedScale: number;
};

export type BinDropScene = {
  kind: "bin_drop";
  cubeStart: [number, number, number];
  target: [number, number, number];
  binCenter: [number, number];
  binWidth: number;
  speedScale: number;
};

export type TossBinScene = {
  kind: "toss_into_bin";
  cubeStart: [number, number, number];
  target: [number, number, number];
  binCenter: [number, number];
  binWallHeight: number;
  speedScale: number;
};

export type ResolvedScene = DividerScene | PushGapScene | BinDropScene | TossBinScene;

const copy3 = (value: readonly number[]): [number, number, number] => [value[0]!, value[1]!, value[2]!];
const copy2 = (value: readonly number[]): [number, number] => [value[0]!, value[1]!];
const valueFor = (overrides: Record<string, number>, key: string, fallback: number) =>
  Number.isFinite(overrides[key]) ? overrides[key]! : fallback;

export function defaultOverride(taskFamily: TaskFamily): Record<string, number> {
  return Object.fromEntries(TASK_FAMILY_SPECS[taskFamily].overrideKeys.map((key) => {
    const defaults: Partial<Record<SceneOverrideKey, number>> = {
      dividerHeight: BASE_SCENES.divider_pick_place.dividerHeight,
      gapWidth: BASE_SCENES.push_through_gap.gapWidth,
      binWidth: BASE_SCENES.bin_drop.binWidth,
      binWallHeight: TOSS_BIN_DEFAULTS.binWallHeight,
      objectMass: TOSS_BIN_DEFAULTS.objectMass,
      speedScale: 1,
    };
    return [key, defaults[key] ?? 0];
  }));
}

export function changedOverrides(taskFamily: TaskFamily, overrides: Record<string, number>): Record<string, number> {
  const defaults = defaultOverride(taskFamily);
  return Object.fromEntries(TASK_FAMILY_SPECS[taskFamily].overrideKeys.flatMap((key) => {
    const value = overrides[key];
    if (!Number.isFinite(value) || Math.abs(value! - defaults[key]!) <= 1e-9) return [];
    return [[key, Math.round(value! * 100_000) / 100_000]];
  }));
}

export function resolveScene(
  taskFamily: TaskFamily | string | undefined,
  overrides: Record<string, number> = {},
): ResolvedScene {
  const family = isTaskFamily(taskFamily) ? taskFamily : DEFAULT_TASK_FAMILY;
  if (family === "toss_into_bin") {
    const cubeStart = copy3(BASE_SCENES.toss_into_bin.cubeStart);
    cubeStart[0] += valueFor(overrides, "objectDx", 0);
    cubeStart[1] += valueFor(overrides, "objectDy", 0);
    const binCenter = copy2(BASE_SCENES.toss_into_bin.binCenter);
    binCenter[0] += valueFor(overrides, "binDx", 0);
    binCenter[1] += valueFor(overrides, "binDy", 0);
    return {
      kind: family,
      cubeStart,
      target: [binCenter[0], binCenter[1], 0.01],
      binCenter,
      binWallHeight: valueFor(overrides, "binWallHeight", BASE_SCENES.toss_into_bin.binWallHeight),
      speedScale: valueFor(overrides, "speedScale", 1),
    };
  }
  const base = family === "bin_drop"
    ? BASE_SCENES.bin_drop
    : family === "divider_pick_place"
      ? BASE_SCENES.divider_pick_place
      : BASE_SCENES.push_through_gap;
  const cubeStart = copy3(base.cubeStart);
  const target = copy3(base.target);
  cubeStart[0] += valueFor(overrides, "cubeDx", 0);
  cubeStart[1] += valueFor(overrides, "cubeDy", 0);
  target[0] += valueFor(overrides, "targetDx", 0);
  target[1] += valueFor(overrides, "targetDy", 0);
  cubeStart[0] = valueFor(overrides, "cube_start_x", cubeStart[0]);
  cubeStart[1] = valueFor(overrides, "cube_start_y", cubeStart[1]);
  target[0] = valueFor(overrides, "target_x", target[0]);
  target[1] = valueFor(overrides, "target_y", target[1]);

  if (family === "bin_drop") {
    const binCenter = copy2(BASE_SCENES.bin_drop.binCenter);
    binCenter[0] += valueFor(overrides, "binDx", 0);
    binCenter[1] += valueFor(overrides, "binDy", 0);
    target[0] = binCenter[0];
    target[1] = binCenter[1];
    return {
      kind: family,
      cubeStart,
      target,
      binCenter,
      binWidth: valueFor(overrides, "binWidth", BASE_SCENES.bin_drop.binWidth),
      speedScale: valueFor(overrides, "speedScale", 1),
    };
  }

  if (family === "divider_pick_place") {
    const dividerCenter = copy2(BASE_SCENES.divider_pick_place.dividerCenter);
    dividerCenter[0] += valueFor(overrides, "dividerDx", 0);
    dividerCenter[1] += valueFor(overrides, "dividerDy", 0);
    dividerCenter[0] = valueFor(overrides, "divider_x", dividerCenter[0]);
    dividerCenter[1] = valueFor(overrides, "divider_y", dividerCenter[1]);
    return {
      kind: family,
      cubeStart,
      target,
      dividerCenter,
      dividerHalfLength: valueFor(overrides, "divider_length", BASE_SCENES.divider_pick_place.dividerHalfLength * 2) / 2,
      dividerHalfThickness: BASE_SCENES.divider_pick_place.dividerHalfThickness,
      dividerHeight: valueFor(overrides, "divider_height", valueFor(overrides, "dividerHeight", BASE_SCENES.divider_pick_place.dividerHeight)),
      speedScale: valueFor(overrides, "speedScale", 1),
    };
  }

  const gapCenter = copy2(BASE_SCENES.push_through_gap.gapCenter);
  gapCenter[0] += valueFor(overrides, "gapDx", 0);
  return {
    kind: family,
    cubeStart,
    target,
    gapCenter,
    gapWidth: valueFor(overrides, "gapWidth", BASE_SCENES.push_through_gap.gapWidth),
    wallHalfThickness: BASE_SCENES.push_through_gap.wallHalfThickness,
    wallHeight: BASE_SCENES.push_through_gap.wallHeight,
    wallSpanX: [...BASE_SCENES.push_through_gap.wallSpanX],
    speedScale: valueFor(overrides, "speedScale", 1),
  };
}

export function sceneOverrideValidation(taskFamily: TaskFamily, overrides: Record<string, number>) {
  return validateSceneOverrides(taskFamily, overrides);
}
