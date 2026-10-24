from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from simulator.runner import finite_json


class StreamWriter:
    def __init__(self, stream_dir: Path, interval_sec: float = 0.5) -> None:
        self.stream_dir = Path(stream_dir)
        self.interval_sec = float(interval_sec)
        self.flushed = 0
        self.seq = 0
        self.last_flush_time = 0.0
        self.stream_dir.mkdir(parents=True, exist_ok=True)

    def _write(self, frames: list[dict[str, Any]], final: bool) -> None:
        payload = finite_json({
            "seq": self.seq,
            "fromIndex": self.flushed,
            "final": final,
            "frames": frames,
        })
        path = self.stream_dir / f"chunk-{self.seq:05d}.json"
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
        os.replace(temporary, path)
        self.flushed += len(frames)
        self.seq += 1

    def maybe_flush(self, frames: list[dict[str, Any]], sim_time: float) -> None:
        if not frames[self.flushed :]:
            return
        if sim_time - self.last_flush_time < self.interval_sec:
            return
        self._write(frames[self.flushed :], final=False)
        self.last_flush_time = sim_time

    def finish(self, final_frames: list[dict[str, Any]]) -> None:
        self._write(final_frames[self.flushed :], final=True)
