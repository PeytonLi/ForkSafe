from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import UUID

from simulator.stream import StreamWriter

ROOT = Path(__file__).resolve().parents[3]
EXPERIMENT_ID = UUID("9da6c39b-633d-4f14-9eb1-2a4ad59de534")


def _run_cli(
    tmp_path: Path, stream: bool
) -> tuple[dict, list[dict]]:
    output_dir = tmp_path / ("streamed" if stream else "regular")
    stream_dir = tmp_path / "chunks"
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "services")
    command = [
        sys.executable,
        "-m",
        "simulator.cli",
        "--controller-dir",
        str(ROOT / "controllers/baseline"),
        "--case-id",
        "original-divider-collision",
        "--seed",
        "0",
        "--out-dir",
        str(output_dir),
        "--experiment-id",
        str(EXPERIMENT_ID),
    ]
    if stream:
        command.extend(["--stream-dir", str(stream_dir)])
    subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    result = json.loads((output_dir / "result.json").read_text())
    chunks = (
        [
            json.loads(path.read_text())
            for path in sorted(stream_dir.glob("chunk-*.json"))
        ]
        if stream
        else []
    )
    return result, chunks


def test_cli_stream_matches_result_and_has_contiguous_chunks(tmp_path: Path) -> None:
    regular, _ = _run_cli(tmp_path, stream=False)
    streamed, chunks = _run_cli(tmp_path, stream=True)

    assert streamed == regular
    assert [chunk["seq"] for chunk in chunks] == list(range(len(chunks)))
    assert [chunk["final"] for chunk in chunks].count(True) == 1
    assert chunks[-1]["final"] is True
    frames: list[dict] = []
    for chunk in chunks:
        assert chunk["fromIndex"] == len(frames)
        frames.extend(chunk["frames"])
    assert frames == streamed["frames"]


def test_stream_writer_flushes_at_half_second_cadence(tmp_path: Path) -> None:
    writer = StreamWriter(tmp_path, interval_sec=0.5)
    frames = []
    for index in range(50):
        frames.append({"tSec": index / 10, "value": index})
        writer.maybe_flush(frames, index / 10)
    writer.finish(frames)

    chunks = [
        json.loads(path.read_text())
        for path in sorted(tmp_path.glob("chunk-*.json"))
    ]
    nonfinal = [chunk for chunk in chunks if not chunk["final"]]
    assert nonfinal
    assert all(len(chunk["frames"]) <= 6 for chunk in nonfinal)
    assert chunks[-1]["final"] is True
    assert all(
        chunk["fromIndex"] == sum(len(previous["frames"]) for previous in chunks[:index])
        for index, chunk in enumerate(chunks)
    )
