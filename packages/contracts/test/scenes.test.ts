import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_FAMILY,
  SCENE_OVERRIDE_RANGES,
  TASK_FAMILIES,
  TASK_FAMILY_SPECS,
  isTaskFamily,
  sceneVariantFor,
  validateSceneOverrides,
  type SceneOverrideKey,
} from "../src/index.js";

const simulatorScene = fileURLToPath(new URL("../../../services/simulator/scene.py", import.meta.url));
const source = readFileSync(simulatorScene, "utf8");

function pythonSet(name: string) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`Could not find ${name} in simulator scene.py`);
  return [...match[1]!.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]!).sort();
}

describe("scene family contracts", () => {
  it("defines known families and the default", () => {
    expect(TASK_FAMILIES).toEqual(["divider_pick_place", "push_through_gap", "bin_drop"]);
    expect(DEFAULT_TASK_FAMILY).toBe("divider_pick_place");
    expect(isTaskFamily("push_through_gap")).toBe(true);
    expect(isTaskFamily("toss_into_bin")).toBe(false);
  });

  it("validates family keys, finite values, and inclusive ranges", () => {
    expect(validateSceneOverrides("missing", {})).toEqual({ ok: false, reason: 'Unknown task "missing".' });
    expect(validateSceneOverrides("divider_pick_place", { divider_x: 0 })).toEqual({
      ok: false,
      reason: 'divider_x isn\'t a setting for "Pick and place over a divider".',
    });
    expect(validateSceneOverrides("divider_pick_place", { cubeDx: Number.NaN })).toEqual({
      ok: false,
      reason: "Move cube away from robot must be a number.",
    });
    expect(validateSceneOverrides("divider_pick_place", { dividerDx: 0.1000000005 })).toEqual({ ok: true });
    expect(validateSceneOverrides("divider_pick_place", { dividerDx: 0.101 })).toEqual({
      ok: false,
      reason: "Move divider away from robot must be between -0.10 m and 0.10 m.",
    });
    expect(validateSceneOverrides("push_through_gap", { dividerDx: 0 })).toEqual({
      ok: false,
      reason: 'dividerDx isn\'t a setting for "Push through a gap".',
    });
    expect(validateSceneOverrides("push_through_gap", { speedScale: 2.1 })).toEqual({
      ok: false,
      reason: "Robot speed must be between 0.50× and 2.00×.",
    });
    expect(SCENE_OVERRIDE_RANGES.gapWidth).toMatchObject({ min: 0.05, max: 0.2, step: 0.005, unit: "m" });
  });

  it("keeps Python simulator override keys in sync with each family", () => {
    const parity = {
      divider_pick_place: "OVERRIDE_KEYS",
      push_through_gap: "PUSH_GAP_OVERRIDE_KEYS",
      bin_drop: "BIN_DROP_OVERRIDE_KEYS",
    } as const;
    for (const [family, setName] of Object.entries(parity)) {
      expect(pythonSet(setName)).toEqual([...TASK_FAMILY_SPECS[family as keyof typeof parity].overrideKeys].sort());
    }
  });

  it("keeps index 0 on the captured baseline", () => {
    const baseline = {
      caseId: "original-divider-collision",
      suite: "original" as const,
      seed: 1042,
      sceneOverrides: { cubeDx: 0.01, cubeDy: -0.02, dividerHeight: 0.15 },
      taskFamily: "divider_pick_place",
      description: "Captured baseline failure",
    };
    const variant = sceneVariantFor(0, baseline);
    expect(variant.seed).toBe(baseline.seed);
    expect(variant.sceneOverrides).toEqual(baseline.sceneOverrides);
    expect(variant.caseId).toBe(baseline.caseId);
    expect(variant.sceneOverrides).not.toBe(baseline.sceneOverrides);
    variant.sceneOverrides.cubeDx = 9;
    expect(baseline.sceneOverrides.cubeDx).toBe(0.01);
    expect(sceneVariantFor(-1, baseline)).toMatchObject({ seed: baseline.seed, sceneOverrides: baseline.sceneOverrides });
  });

  it("gives later divider environments a different in-range setting and seed", () => {
    const baseline = {
      caseId: "original-divider-collision",
      suite: "original" as const,
      seed: 1042,
      sceneOverrides: { cubeDx: 0.01, cubeDy: -0.02, dividerHeight: 0.15 },
      taskFamily: "divider_pick_place",
      description: "Captured baseline failure",
    };
    const first = sceneVariantFor(1, baseline);
    const second = sceneVariantFor(2, baseline);
    expect(first.seed).toBe(baseline.seed + 1);
    expect(second.seed).toBe(baseline.seed + 2);
    expect(first.caseId).toBe(baseline.caseId);
    expect(second.caseId).toBe(baseline.caseId);
    expect(first.suite).toBe(baseline.suite);
    expect(second.taskFamily).toBe(baseline.taskFamily);

    const before = baseline.sceneOverrides as Record<string, number>;
    const changedKeys = (variant: { sceneOverrides: Record<string, number> }) => Object.keys({ ...before, ...variant.sceneOverrides })
      .filter((key) => variant.sceneOverrides[key] !== before[key]);
    const firstKeys = changedKeys(first);
    const secondKeys = changedKeys(second);
    expect(firstKeys).toEqual(["cubeDx"]);
    expect(secondKeys).toEqual(["cubeDy"]);
    expect(first.sceneOverrides.cubeDx).toBeCloseTo(0.015, 5);
    expect(second.sceneOverrides.cubeDy).toBeCloseTo(-0.025, 5);
    expect(first.description).toContain("Environment 2");
    expect(first.description).toContain(SCENE_OVERRIDE_RANGES.cubeDx.label);
    expect(second.description).toContain("Environment 3");
    expect(second.description).toContain(SCENE_OVERRIDE_RANGES.cubeDy.label);

    for (const variant of [first, second]) {
      for (const [key, value] of Object.entries(variant.sceneOverrides)) {
        const range = SCENE_OVERRIDE_RANGES[key as SceneOverrideKey];
        expect(value).toBeGreaterThanOrEqual(range.min);
        expect(value).toBeLessThanOrEqual(range.max);
        expect(value).toBe(Number(value.toFixed(5)));
      }
    }
  });

  it("steps the other way when the setting is already at its max", () => {
    const max = SCENE_OVERRIDE_RANGES.cubeDx.max;
    const baseline = {
      caseId: "original-divider-collision",
      suite: "public" as const,
      seed: 3,
      sceneOverrides: { cubeDx: max },
      taskFamily: "divider_pick_place",
    };
    const variant = sceneVariantFor(1, baseline);
    expect(variant.sceneOverrides.cubeDx).toBe(Number((max - SCENE_OVERRIDE_RANGES.cubeDx.step).toFixed(5)));
    expect(variant.sceneOverrides.cubeDx).toBeLessThanOrEqual(max);
    expect(variant.sceneOverrides.cubeDx).toBeGreaterThanOrEqual(SCENE_OVERRIDE_RANGES.cubeDx.min);
    expect(variant.seed).toBe(4);
  });

  it("nudges only a push-through-gap setting", () => {
    const baseline = {
      caseId: "push-gap-aligned",
      suite: "original" as const,
      seed: 7,
      sceneOverrides: { gapWidth: 0.08, gapDx: -0.02, cubeDx: 0.01, dividerHeight: 0.2 },
      taskFamily: "push_through_gap",
    };
    const own = new Set<string>(TASK_FAMILY_SPECS.push_through_gap.overrideKeys);
    const before = baseline.sceneOverrides as Record<string, number>;
    const variant = sceneVariantFor(1, baseline);
    const changed = Object.keys({ ...before, ...variant.sceneOverrides })
      .filter((key) => variant.sceneOverrides[key] !== before[key]);
    expect(changed).toEqual(["cubeDx"]);
    expect(own.has(changed[0]!)).toBe(true);
    expect(variant.sceneOverrides.dividerHeight).toBe(0.2);
    expect(variant.sceneOverrides.gapWidth).toBe(0.08);
    expect(variant.seed).toBe(baseline.seed + 1);
    expect(variant.taskFamily).toBe("push_through_gap");

    const later = sceneVariantFor(7, baseline);
    const laterChanged = Object.keys({ ...before, ...later.sceneOverrides })
      .filter((key) => later.sceneOverrides[key] !== before[key]);
    expect(laterChanged).toHaveLength(1);
    expect(own.has(laterChanged[0]!)).toBe(true);
    expect(laterChanged[0]).not.toBe("dividerHeight");
    expect(later.sceneOverrides.dividerDx).toBeUndefined();
  });

  it("keeps Python task_family cases in sync", () => {
    const match = source.match(/def task_family\([^\n]*\)\s*->\s*str:\s*([\s\S]*?)(?=\n\ndef )/);
    expect(match).not.toBeNull();
    const cases = [...match![1]!.matchAll(/["']([a-z_]+)["']/g)].map((entry) => entry[1]!);
    expect([...new Set(cases)].sort()).toEqual([...TASK_FAMILIES].sort());
  });
});
