import { describe, expect, it } from "vitest";
import type { SimFrame } from "@forksafe/contracts";
import { LiveBuffer } from "./liveBuffer";

const frame = (tSec: number): SimFrame => ({
  tSec,
  qpos: [],
  qvel: [],
  ctrl: [],
  bodies: [],
  contacts: [],
  attached: false,
});
const chunk = (seq: number, start: number, count = 5) => ({
  seq,
  final: false,
  frames: Array.from({ length: count }, (_, i) => frame(start + i * 0.1)),
});

describe("LiveBuffer", () => {
  it("holds for the startup buffer and then plays at 1x", () => {
    const buffer = new LiveBuffer();
    buffer.push([chunk(0, 0)]);
    expect(buffer.advance(0.1)).toMatchObject({ t: 0, state: "buffering" });
    buffer.push([chunk(1, 0.5)]);
    expect(buffer.advance(0.1)).toMatchObject({ t: 0.1, state: "playing" });
  });

  it("plays steadily and buffers again on underrun", () => {
    const buffer = new LiveBuffer();
    buffer.push([chunk(0, 0, 20)]);
    const first = buffer.advance(0.1);
    const second = buffer.advance(0.1);
    expect(first.state).toBe("playing");
    expect(second.t - first.t).toBeCloseTo(0.1);
    buffer.advance(1);
    buffer.advance(0.1);
    expect(buffer.advance(0.1).state).toBe("buffering");
  });

  it("deduplicates chunks and sorts out-of-order updates", () => {
    const buffer = new LiveBuffer();
    buffer.push([chunk(2, 1)]);
    buffer.push([chunk(1, 0.5), chunk(2, 1), chunk(0, 0)]);
    expect(buffer.frames.map((f) => Number(f.tSec.toFixed(1)))).toEqual([
      0, 0.1, 0.2, 0.3, 0.4,
      0.5, 0.6, 0.7, 0.8, 0.9,
      1, 1.1, 1.2, 1.3, 1.4,
    ]);
    buffer.push([chunk(0, -1)]);
    expect(buffer.frames[0]?.tSec).toBe(0);
  });

  it("catches up when far behind and supports skip-to-latest", () => {
    const buffer = new LiveBuffer();
    buffer.push([chunk(0, 0, 100)]);
    expect(buffer.advance(0).state).toBe("playing");
    expect(buffer.advance(0).t).toBeCloseTo(9.3);
    buffer.skipToLatest();
    expect(buffer.t).toBeCloseTo(9.3);
    expect(buffer.lagSec).toBeCloseTo(0.6);
  });

  it("caps retained frames near 300", () => {
    const buffer = new LiveBuffer();
    buffer.push(Array.from({ length: 70 }, (_, seq) => chunk(seq, seq * 0.5)));
    expect(buffer.frames).toHaveLength(300);
    expect(buffer.frames[0]?.tSec).toBeGreaterThan(0);
  });
});
