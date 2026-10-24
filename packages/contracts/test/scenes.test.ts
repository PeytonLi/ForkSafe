import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_FAMILY,
  SCENE_OVERRIDE_RANGES,
  TASK_FAMILIES,
  TASK_FAMILY_SPECS,
  isTaskFamily,
  validateSceneOverrides,
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
    expect(TASK_FAMILIES).toEqual(["divider_pick_place", "push_through_gap"]);
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
    } as const;
    for (const [family, setName] of Object.entries(parity)) {
      expect(pythonSet(setName)).toEqual([...TASK_FAMILY_SPECS[family as keyof typeof parity].overrideKeys].sort());
    }
  });

  it("keeps Python task_family cases in sync", () => {
    const match = source.match(/def task_family\([^\n]*\)\s*->\s*str:\s*([\s\S]*?)(?=\n\ndef )/);
    expect(match).not.toBeNull();
    const cases = [...match![1]!.matchAll(/["']([a-z_]+)["']/g)].map((entry) => entry[1]!);
    expect([...new Set(cases)].sort()).toEqual([...TASK_FAMILIES].sort());
  });
});
