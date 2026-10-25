import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE_SCENES, changedOverrides, defaultOverride, resolveScene } from "./scene";

describe("scene resolver", () => {
  it("mirrors the simulator base configs", () => {
    const divider = JSON.parse(readFileSync(fileURLToPath(new URL("../../../services/simulator/scene_config.json", import.meta.url)), "utf8"));
    const pushGap = JSON.parse(readFileSync(fileURLToPath(new URL("../../../services/simulator/scene_configs/push_gap.json", import.meta.url)), "utf8"));
    const binDrop = JSON.parse(readFileSync(fileURLToPath(new URL("../../../services/simulator/scene_configs/bin_drop.json", import.meta.url)), "utf8"));
    expect(BASE_SCENES.divider_pick_place).toEqual(divider);
    expect(BASE_SCENES.push_through_gap).toEqual(pushGap);
    expect(BASE_SCENES.bin_drop).toEqual(binDrop);
  });

  it("resolves delta overrides for the divider scene", () => {
    expect(resolveScene("divider_pick_place", { cubeDx: 0.02, dividerDy: 0.01, dividerHeight: 0.12 })).toMatchObject({
      cubeStart: [0.52, -0.15, 0.02],
      dividerCenter: [0.5, 0.01],
      dividerHeight: 0.12,
    });
  });

  it("maps recorded legacy absolute values", () => {
    expect(resolveScene(undefined, {
      divider_x: 0.5,
      divider_y: 0,
      divider_height: 0.15,
      divider_length: 0.3,
      cube_start_x: 0.5,
      cube_start_y: -0.2,
      target_x: 0.5,
      target_y: 0.2,
    })).toMatchObject({
      cubeStart: [0.5, -0.2, 0.02],
      target: [0.5, 0.2, 0.02],
      dividerCenter: [0.5, 0],
      dividerHalfLength: 0.15,
      dividerHeight: 0.15,
    });
  });

  it("resolves push-gap geometry", () => {
    expect(resolveScene("push_through_gap", { gapDx: 0.02, gapWidth: 0.08, targetDx: 0.01 })).toMatchObject({
      kind: "push_through_gap",
      gapCenter: [0.52, 0],
      gapWidth: 0.08,
      target: [0.51, 0.15, 0.02],
    });
  });

  it("resolves toss overrides independently from bin-drop geometry", () => {
    const toss = resolveScene("toss_into_bin", {
      objectDx: 0.02,
      objectDy: -0.01,
      binDx: -0.05,
      binDy: 0.1,
      binWallHeight: 0.1,
    });
    expect(toss.kind).toBe("toss_into_bin");
    if (toss.kind !== "toss_into_bin") throw new Error("Expected toss scene");
    expect(toss.cubeStart[0]).toBeCloseTo(0.47);
    expect(toss.cubeStart[1]).toBeCloseTo(-0.11);
    expect(toss.binCenter[0]).toBeCloseTo(0.9);
    expect(toss.binCenter[1]).toBeCloseTo(0.1);
    expect(toss.binWallHeight).toBe(0.1);
    const binDrop = resolveScene("bin_drop", { binDx: 0.08, binWidth: 0.2 });
    if (binDrop.kind !== "bin_drop") throw new Error("Expected bin-drop scene");
    expect(binDrop.binCenter[0]).toBeCloseTo(0.7);
    expect(binDrop.binCenter[1]).toBe(0.16);
  });

  it("provides defaults and only reports meaningful changes", () => {
    const defaults = defaultOverride("divider_pick_place");
    expect(defaults).toMatchObject({ dividerHeight: 0.1, speedScale: 1, cubeDx: 0 });
    expect(changedOverrides("divider_pick_place", { ...defaults, cubeDx: 0.02, targetDy: 1e-10 })).toEqual({ cubeDx: 0.02 });
  });
});
