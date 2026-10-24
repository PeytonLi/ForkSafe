import type { SimFrame } from "@forksafe/contracts";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** MuJoCo is Z-up, right-handed (x forward, y left, z up). Three.js is Y-up.
 *  Rotate -90° about X: (x, y, z)_mj -> (x, z, -y)_three. */
export function mjToThreePos([x, y, z]: Vec3): Vec3 {
  return [x, z, -y];
}

/** MuJoCo quaternions are [w, x, y, z]; returns Three.js order [x, y, z, w]
 *  after the same basis change as mjToThreePos. */
export function mjToThreeQuat([w, x, y, z]: Quat): Quat {
  return [x, z, -y, w];
}

export interface SampledBody {
  name: string;
  pos: Vec3;
  quat: Quat;
}

export interface Sample {
  tSec: number;
  bodies: Map<string, SampledBody>;
  contacts: SimFrame["contacts"];
  attached: boolean;
  frameIndex: number;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

function slerp(a: Quat, b: Quat, u: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = dot < 0 ? (b.map((v) => -v) as Quat) : b;
  dot = Math.abs(dot);
  if (dot > 0.9995) {
    const q = a.map((v, i) => lerp(v, bb[i]!, u)) as Quat;
    const n = Math.hypot(...q);
    return q.map((v) => v / n) as Quat;
  }
  const th = Math.acos(dot);
  const s = Math.sin(th);
  const wa = Math.sin((1 - u) * th) / s;
  const wb = Math.sin(u * th) / s;
  return a.map((v, i) => v * wa + bb[i]! * wb) as Quat;
}

/** Interpolates sampled authoritative state at time t (never simulates). */
export function sampleAt(frames: SimFrame[], t: number): Sample | undefined {
  if (!frames.length) return undefined;
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  const tc = Math.min(Math.max(t, first.tSec), last.tSec);
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.tSec <= tc) lo = mid;
    else hi = mid;
  }
  const a = frames[lo]!;
  const b = frames[hi]!;
  const u = b.tSec > a.tSec ? (tc - a.tSec) / (b.tSec - a.tSec) : 0;
  const bodies = new Map<string, SampledBody>();
  for (const ba of a.bodies) {
    const bb = b.bodies.find((x) => x.name === ba.name) ?? ba;
    bodies.set(ba.name, {
      name: ba.name,
      pos: [lerp(ba.pos[0], bb.pos[0], u), lerp(ba.pos[1], bb.pos[1], u), lerp(ba.pos[2], bb.pos[2], u)],
      quat: slerp(ba.quat, bb.quat, u),
    });
  }
  const near = u < 0.5 ? a : b;
  return { tSec: tc, bodies, contacts: near.contacts, attached: near.attached, frameIndex: u < 0.5 ? lo : hi };
}

export const replayDuration = (frames: SimFrame[]) => (frames.length ? frames[frames.length - 1]!.tSec : 0);
