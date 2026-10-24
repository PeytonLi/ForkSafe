import type { SimFrame } from "@forksafe/contracts";

export const BUFFER_SEC = 0.6;
export const MAX_LAG_SEC = 5;
const MAX_RETAINED_FRAMES = 300;

export type LivePlaybackState = "buffering" | "playing";

export class LiveBuffer {
  private chunks = new Map<number, { seq: number; final: boolean; frames: SimFrame[] }>();
  private frameList: SimFrame[] = [];
  private playhead = 0;
  private started = false;
  private oldestAllowedSeq = 0;

  get frames() {
    return this.frameList;
  }

  get latestT() {
    return this.frameList[this.frameList.length - 1]?.tSec ?? 0;
  }

  get lagSec() {
    return Math.max(0, this.latestT - this.playhead);
  }

  get t() {
    return this.playhead;
  }

  push(chunks: { seq: number; final: boolean; frames: SimFrame[] }[]) {
    for (const chunk of chunks) {
      if (this.chunks.has(chunk.seq) || chunk.seq < this.oldestAllowedSeq) continue;
      this.chunks.set(chunk.seq, chunk);
    }
    const ordered = [...this.chunks.values()].sort((a, b) => a.seq - b.seq);
    this.frameList = ordered.flatMap((chunk) => chunk.frames);
    while (this.frameList.length > MAX_RETAINED_FRAMES && ordered.length > 1) {
      const oldest = ordered.shift()!;
      this.chunks.delete(oldest.seq);
      this.oldestAllowedSeq = Math.max(this.oldestAllowedSeq, oldest.seq + 1);
      this.frameList = ordered.flatMap((chunk) => chunk.frames);
    }
    if (this.frameList.length > MAX_RETAINED_FRAMES) {
      this.frameList = this.frameList.slice(-MAX_RETAINED_FRAMES);
      const only = ordered[0];
      if (only) this.chunks.set(only.seq, { ...only, frames: this.frameList });
    }
    if (!this.started && this.frameList.length) {
      this.playhead = this.frameList[0]!.tSec;
      this.started = true;
    }
  }

  advance(dtSec: number): { t: number; state: LivePlaybackState } {
    if (!this.frameList.length) return { t: this.playhead, state: "buffering" };
    if (this.lagSec > MAX_LAG_SEC) this.playhead = Math.max(this.frameList[0]!.tSec, this.latestT - BUFFER_SEC);
    const available = this.latestT - this.playhead;
    if (available < BUFFER_SEC - 1e-9 || (available <= BUFFER_SEC + 1e-9 && dtSec > 0 && this.playhead > this.frameList[0]!.tSec)) {
      return { t: this.playhead, state: "buffering" };
    }
    this.playhead = Math.min(this.playhead + Math.max(0, dtSec), this.latestT - BUFFER_SEC);
    return { t: this.playhead, state: "playing" };
  }

  skipToLatest() {
    if (!this.frameList.length) return;
    this.playhead = Math.max(this.frameList[0]!.tSec, this.latestT - BUFFER_SEC);
    this.started = true;
  }
}
