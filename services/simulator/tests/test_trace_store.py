from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import UUID

import pytest
from simulator.models import SimCase
from simulator.runner import SIMULATOR_ROOT, run_case
from simulator.trace_store import (
    MAX_CHUNK_BYTES,
    TraceChunkError,
    TraceIntegrityError,
    export_trace,
    read_trace,
)

BASELINE = SIMULATOR_ROOT / "controllers/baseline"
MULTI_CHUNK_LIMIT = 64_000
ORIGINAL = SimCase(
    caseId="original-divider-collision",
    suite="original",
    seed=0,
    sceneOverrides={},
)


@pytest.fixture(scope="module")
def real_trace() -> dict[str, object]:
    _, trace = run_case(BASELINE, ORIGINAL, 0, UUID(int=10))
    return trace


def _manifest(out_dir: Path) -> dict[str, object]:
    return json.loads((out_dir / "trace-manifest.json").read_text())


def _write_manifest(out_dir: Path, manifest: dict[str, object]) -> None:
    (out_dir / "trace-manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    )


def test_real_trace_round_trip_chunk_ranges_and_idempotence(
    real_trace: dict[str, object], tmp_path: Path
) -> None:
    first = export_trace(real_trace, tmp_path, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    manifest = _manifest(tmp_path)
    assert first["frameCount"] == len(real_trace["frames"])
    assert first["chunkCount"] > 1
    assert read_trace(tmp_path, first["manifestSha256"]) == real_trace
    assert read_trace(tmp_path) == real_trace

    cursor = 0
    for entry in manifest["chunks"]:
        assert entry["frameStart"] == cursor
        assert entry["frameEnd"] > cursor
        chunk_path = tmp_path / "trace-chunks" / f'{entry["sha256"]}.json'
        assert chunk_path.stat().st_size == entry["bytes"]
        assert entry["bytes"] <= manifest["maxChunkBytes"]
        cursor = entry["frameEnd"]
    assert cursor == len(real_trace["frames"])

    second = export_trace(real_trace, tmp_path, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    assert second == first
    assert read_trace(tmp_path, first["manifestSha256"]) == real_trace


def test_chunk_deduplication_across_exports(
    real_trace: dict[str, object], tmp_path: Path
) -> None:
    left = tmp_path / "left"
    right = tmp_path / "right"
    export_trace(real_trace, left, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    second_trace = {**real_trace, "testExtra": "changed"}
    export_trace(second_trace, right, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    left_manifest = _manifest(left)
    right_manifest = _manifest(right)
    assert [entry["sha256"] for entry in left_manifest["chunks"]] == [
        entry["sha256"] for entry in right_manifest["chunks"]
    ]


def test_tampering_missing_reordered_overlapping_and_traversal(
    real_trace: dict[str, object], tmp_path: Path
) -> None:
    tampered = tmp_path / "tampered"
    export_trace(real_trace, tampered, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    manifest = _manifest(tampered)
    digest = manifest["chunks"][0]["sha256"]
    chunk_path = tampered / "trace-chunks" / f"{digest}.json"
    chunk_path.write_bytes(chunk_path.read_bytes() + b" ")
    with pytest.raises(TraceIntegrityError, match="chunk 0 integrity"):
        read_trace(tampered)

    missing = tmp_path / "missing"
    export_trace(real_trace, missing, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    missing_manifest = _manifest(missing)
    first_digest = missing_manifest["chunks"][0]["sha256"]
    (missing / "trace-chunks" / f"{first_digest}.json").unlink()
    with pytest.raises(TraceIntegrityError, match="chunk 0"):
        read_trace(missing)

    reordered = tmp_path / "reordered"
    export_trace(real_trace, reordered, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    reordered_manifest = _manifest(reordered)
    reordered_manifest["chunks"][0], reordered_manifest["chunks"][1] = (
        reordered_manifest["chunks"][1],
        reordered_manifest["chunks"][0],
    )
    _write_manifest(reordered, reordered_manifest)
    with pytest.raises(TraceIntegrityError, match="chunk 0 index"):
        read_trace(reordered)

    overlapping = tmp_path / "overlapping"
    export_trace(real_trace, overlapping, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    overlap_manifest = _manifest(overlapping)
    overlap_manifest["chunks"][1]["frameStart"] = 0
    _write_manifest(overlapping, overlap_manifest)
    with pytest.raises(TraceIntegrityError, match="chunk 1 range"):
        read_trace(overlapping)

    traversal = tmp_path / "traversal"
    export_trace(real_trace, traversal, max_chunk_bytes=MULTI_CHUNK_LIMIT)
    traversal_manifest = _manifest(traversal)
    traversal_manifest["chunks"][0]["sha256"] = "../" + "a" * 64
    _write_manifest(traversal, traversal_manifest)
    with pytest.raises(TraceIntegrityError, match="chunk 0 sha256"):
        read_trace(traversal)


def test_expected_manifest_and_oversized_frame(
    real_trace: dict[str, object], tmp_path: Path
) -> None:
    ref = export_trace(real_trace, tmp_path)
    assert _manifest(tmp_path)["maxChunkBytes"] == MAX_CHUNK_BYTES
    with pytest.raises(TraceIntegrityError, match="manifest sha256 mismatch"):
        read_trace(tmp_path, "0" * 64)
    assert read_trace(tmp_path, ref["manifestSha256"]) == real_trace
    oversized = {"frames": [{"tSec": 0.0, "payload": "x" * 2000}]}
    with pytest.raises(TraceChunkError, match="frame 0 exceeds"):
        export_trace(oversized, tmp_path / "small", max_chunk_bytes=500)
    bad_trace = {**real_trace, "frames": [{"tSec": float("nan")}]}
    with pytest.raises(TraceChunkError, match="invalid tSec"):
        export_trace(bad_trace, tmp_path / "bad-time")


def test_legacy_cli_exports_invalid_run_trace(tmp_path: Path) -> None:
    root = SIMULATOR_ROOT
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root / "services")
    out_dir = tmp_path / "invalid"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "simulator.cli",
            "--controller-dir",
            str(tmp_path / "missing-controller"),
            "--case-id",
            ORIGINAL.case_id,
            "--seed",
            "0",
            "--out-dir",
            str(out_dir),
            "--experiment-id",
            str(UUID(int=11)),
        ],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 1
    result = json.loads((out_dir / "result.json").read_text())
    trace = json.loads((out_dir / "trace.json").read_text())
    assert result["failureKinds"] == ["invalid_run"]
    assert result["traceRef"]["frameCount"] == 0
    assert read_trace(out_dir, result["traceRef"]["manifestSha256"]) == trace
    assert completed.stdout == ""
