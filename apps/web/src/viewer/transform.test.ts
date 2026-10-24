import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { mjToThreePos, mjToThreeQuat, sampleAt } from "./transform";
import type { SimFrame } from "@forksafe/contracts";

describe("MuJoCo -> Three.js transform", () => {
  it("maps Z-up to Y-up and preserves distances", () => {
    expect(mjToThreePos([0, 0, 1])).toEqual([0, 1, -0]);
    expect(mjToThreePos([0, 1, 0])).toEqual([0, 0, -1]);
    const a = new Vector3(...mjToThreePos([0.5, -0.2, 0.025]));
    const b = new Vector3(...mjToThreePos([0.5, 0.2, 0.025]));
    expect(a.distanceTo(b)).toBeCloseTo(0.4, 9);
  });

  it("maps a 90° yaw about MuJoCo Z to a rotation about Three Y", () => {
    const s = Math.SQRT1_2;
    const q = new Quaternion(...mjToThreeQuat([s, 0, 0, s]));
    const xAxis = new Vector3(1, 0, 0).applyQuaternion(q);
    // MuJoCo yaw +90° turns +x into +y_mj, which is -z in Three.
    expect(xAxis.x).toBeCloseTo(0, 9);
    expect(xAxis.z).toBeCloseTo(-1, 9);
  });

  it("interpolates between sampled frames without extrapolating", () => {
    const f = (t: number, x: number): SimFrame => ({
      tSec: t, qpos: [], qvel: [], ctrl: [], contacts: [], attached: false,
      bodies: [{ name: "cube", pos: [x, 0, 0], quat: [1, 0, 0, 0] }],
    });
    const frames = [f(0, 0), f(0.1, 1)];
    expect(sampleAt(frames, 0.05)!.bodies.get("cube")!.pos[0]).toBeCloseTo(0.5);
    expect(sampleAt(frames, 5)!.bodies.get("cube")!.pos[0]).toBe(1);
  });
});
