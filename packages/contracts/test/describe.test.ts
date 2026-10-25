import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DESCRIBE_HINTS, SCENE_DEFAULTS, TASK_FAMILY_SPECS, describeScene,
  isTaskFamily, normalizeDescribedOverrides, validateSceneOverrides,
} from "../src/index.js";

describe("describe scene", () => {
  it.each([
    ["a robot pushing a box through a narrow opening, a bit faster than usual", "push_through_gap", { gapWidth: 0.06, speedScale: 1.3 }],
    ["robot arm lifting a cube over a tall wall", "divider_pick_place", { dividerHeight: 0.15 }],
    ["pick and place over a very low divider, slower", "divider_pick_place", { dividerHeight: 0.04, speedScale: 0.75 }],
    ["push the block through a very wide gap", "push_through_gap", { gapWidth: 0.12 }],
    ["push through the gap twice as fast", "push_through_gap", { speedScale: 2 }],
    ["pick up the cube and place it, cube a bit to the left", "divider_pick_place", { cubeDy: 0.025 }],
    ["target further away, push through gap", "push_through_gap", { targetDx: 0.05 }],
    ["gap closer, push through", "push_through_gap", { gapDx: -0.05 }],
    ["robot carries the box over the divider at 1.5x", "divider_pick_place", { speedScale: 1.5 }],
    ["lift over the barrier at 5x speed", "divider_pick_place", { speedScale: 2 }],
    ["push through gap at 0.01×", "push_through_gap", { speedScale: 0.5 }],
    ["a robot pushing a box", "push_through_gap", {}],
    ["slide through a very tight slot", "push_through_gap", { gapWidth: 0.05 }],
    ["lift over a very tall divider, half speed", "divider_pick_place", { dividerHeight: 0.2, speedScale: 0.5 }],
    ["barrier to the right, lift the cube", "divider_pick_place", { dividerDy: -0.05 }],
    ["push, target slightly closer", "push_through_gap", { targetDx: -0.025 }],
    ["PUSH A BOX THROUGH AN OPENING, MUCH FASTER!", "push_through_gap", { speedScale: 1.6 }],
    ["push through a gap, cube right, target left", "push_through_gap", { cubeDy: -0.05, targetDy: 0.05 }],
    ["drop the cube into a bin", "bin_drop", {}],
  ] as const)("matches %s", (phrase, family, overrides) => {
    const result = describeScene(phrase);
    expect(result).toMatchObject({ status: "matched", taskFamily: family, overrides });
    if (result.status === "matched") expect(validateSceneOverrides(result.taskFamily, result.overrides)).toEqual({ ok: true });
  });

  it.each(["a drone landing", "a dog walking", "robot flying over a divider", "hello", "a robot", "a forklift", "a pushy cat"])("refuses %s", (phrase) => {
    const result = describeScene(phrase);
    expect(result.status).toBe("unsupported");
    for (const spec of Object.values(TASK_FAMILY_SPECS)) expect(result.explanation).toContain(spec.title);
  });

  it("keeps throw/toss reserved until the real task is registered", () => {
    expect(describeScene("robot throwing trash into a bin").status).toBe(isTaskFamily("toss_into_bin") ? "matched" : "unsupported");
    expect(describeScene("robot throwing a box through a narrow gap").status).toBe(isTaskFamily("toss_into_bin") ? "matched" : "unsupported");
    expect(DESCRIBE_HINTS.toss_into_bin?.strong).toContain("trash");
  });

  it("activates an existing hints entry with just a family registration", () => {
    const specs = TASK_FAMILY_SPECS as Record<string, unknown>;
    specs.toss_into_bin = { title: "Toss into a bin", overrideKeys: ["speedScale"] };
    try {
      expect(describeScene("robot throwing trash into a bin faster")).toMatchObject({ status: "matched", taskFamily: "toss_into_bin", overrides: { speedScale: 1.3 } });
    } finally { delete specs.toss_into_bin; }
  });

  it("gives a plain, reproducible explanation of validated settings", () => {
    expect(describeScene("a robot pushing a box through a narrow opening, a bit faster than usual").explanation)
      .toBe("Matched: Push through a gap. Narrower gap (0.06 m), robot speed 1.3×.");
  });

  it("clamps, snaps to steps, drops defaults and family-incompatible fields", () => {
    expect(normalizeDescribedOverrides("push_through_gap", { gapWidth: 9, cubeDx: -4, cubeDy: 0.026, speedScale: 1, dividerHeight: 0.2 }))
      .toEqual({ gapWidth: 0.2, cubeDx: -0.1, cubeDy: 0.025 });
    for (const value of [NaN, Infinity, "0.1", {}, []]) expect(() => normalizeDescribedOverrides("push_through_gap", { gapWidth: value })).toThrow();
  });

  it("bounds description length for fixture and server callers", () => {
    expect(describeScene("")).toMatchObject({ status: "unsupported", explanation: "Type a short description of the scene first." });
    expect(describeScene("push".repeat(126))).toMatchObject({ status: "unsupported", explanation: "Describe the scene in 500 characters or fewer." });
  });

  it("keeps base modifier values in parity with simulator configs", () => {
    const config = (path: string) => JSON.parse(readFileSync(new URL(`../../../services/simulator/${path}`, import.meta.url), "utf8"));
    expect(SCENE_DEFAULTS.dividerHeight).toBe(config("scene_config.json").dividerHeight);
    expect(SCENE_DEFAULTS.gapWidth).toBe(config("scene_configs/push_gap.json").gapWidth);
    expect(SCENE_DEFAULTS.binWidth).toBe(config("scene_configs/bin_drop.json").binWidth);
    expect(SCENE_DEFAULTS.speedScale).toBe(1);
  });
});
