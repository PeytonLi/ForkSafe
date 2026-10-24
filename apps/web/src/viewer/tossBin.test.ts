import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { makeTossBin, placeTossBin } from "./tossBin";

describe("toss replay bin", () => {
  it("builds an open-top bin with contract dimensions", () => {
    const group = makeTossBin();
    expect(group.visible).toBe(false);
    expect(group.children.map((child) => child.name)).toEqual([
      "bin_floor",
      "bin_wall_px",
      "bin_wall_nx",
      "bin_wall_py",
      "bin_wall_ny",
    ]);
    expect(group.children).toHaveLength(5);
    const firstWall = group.children[1] as THREE.Mesh;
    expect((firstWall.geometry as THREE.BoxGeometry).parameters.height).toBe(0.08);
    const taller = makeTossBin(0.12);
    expect(
      ((taller.children[1] as THREE.Mesh).geometry as THREE.BoxGeometry)
        .parameters.height,
    ).toBe(0.12);
  });

  it("positions the bin from sampled body state and hides absent bins", () => {
    const group = makeTossBin();
    placeTossBin(group, {
      name: "bin",
      pos: [1.02, 0.2, 0],
      quat: [1, 0, 0, 0],
    });
    expect(group.visible).toBe(true);
    expect(group.position.toArray()).toEqual([1.02, 0, -0.2]);
    placeTossBin(group);
    expect(group.visible).toBe(false);
  });
});
