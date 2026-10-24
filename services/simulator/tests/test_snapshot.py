from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import UUID

import pytest
from simulator.models import SimCase
from simulator.runner import SIMULATOR_ROOT, RunSession, run_case
from simulator.snapshot import (
    SnapshotIntegrityError,
    SnapshotMismatchError,
    SnapshotStepUnreachable,
    make_snapshot,
    restore_session,
)

BASELINE = SIMULATOR_ROOT / "controllers/baseline"
REFERENCE = SIMULATOR_ROOT / "evaluation/reference_controller"
ORIGINAL = SimCase(
    caseId="original-divider-collision",
    suite="original",
    seed=0,
    sceneOverrides={},
)
TIMESTEP = 0.002


def _capture_run(
    controller_dir: Path, case: SimCase, snapshot_steps: list[int]
) -> tuple[dict[str, object], dict[str, object], list[dict[str, object]]]:
    session = RunSession.start(controller_dir, case, case.seed, UUID(int=1))
    snapshots = []
    for target_step in sorted(snapshot_steps):
        while session.step_count < target_step and session.step():
            pass
        assert session.step_count == target_step
        snapshot = make_snapshot(session)
        assert make_snapshot(session) == snapshot
        snapshots.append(snapshot)
    session.run_to_end()
    result, trace = session.finish()
    return result, trace, snapshots


def _assert_restored_suffix(
    controller_dir: Path,
    snapshot: dict[str, object],
    expected_result: dict[str, object],
    expected_trace: dict[str, object],
) -> None:
    session = restore_session(snapshot, controller_dir, UUID(int=2))
    session.run_to_end()
    result, trace = session.finish()
    first_time = trace["frames"][0]["tSec"]
    expected_frames = [
        frame for frame in expected_trace["frames"] if frame["tSec"] >= first_time
    ]
    assert trace["frames"] == expected_frames
    assert result["frames"] == expected_frames
    assert trace["finalState"] == expected_trace["finalState"]
    assert trace["attachmentEvents"] == expected_trace["attachmentEvents"]
    assert result["completed"] == expected_result["completed"]
    assert result.get("completionTimeSec") == expected_result.get("completionTimeSec")
    assert result.get("firstFailure") == expected_result.get("firstFailure")
    assert trace["restoredFrom"]["stepIndex"] == snapshot["manifest"]["stepIndex"]


def test_baseline_snapshot_restore_is_bit_identical_across_boundaries() -> None:
    _, reference_trace = run_case(BASELINE, ORIGINAL, 0, UUID(int=1))
    attach_time = reference_trace["attachmentEvents"][0]["tSec"]
    after_attach = round(attach_time / TIMESTEP) + 50
    off_cadence = after_attach + 23
    result, trace, snapshots = _capture_run(
        BASELINE, ORIGINAL, [1500, after_attach, off_cadence]
    )
    assert after_attach != 1500
    assert off_cadence % 5 != 0
    assert off_cadence % 50 != 0
    assert trace["frames"] == reference_trace["frames"]
    assert result["firstFailure"] == reference_trace["finalState"]["failure"]
    for snapshot in snapshots:
        _assert_restored_suffix(BASELINE, snapshot, result, trace)


def test_reference_snapshot_restore_is_bit_identical() -> None:
    case = SimCase(
        caseId="original-divider-collision",
        suite="original",
        seed=0,
        sceneOverrides={},
    )
    expected_result, expected_trace, snapshots = _capture_run(
        REFERENCE, case, [2503]
    )
    assert expected_result["completed"]
    _assert_restored_suffix(
        REFERENCE, snapshots[0], expected_result, expected_trace
    )


def _rehash(snapshot: dict[str, object]) -> None:
    payload = {
        key: snapshot[key]
        for key in ("schema", "manifest", "state")
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode()
    snapshot["snapshotSha256"] = hashlib.sha256(encoded).hexdigest()


def test_snapshot_integrity_and_environment_mismatches() -> None:
    session = RunSession.start(BASELINE, ORIGINAL, 0, UUID(int=1))
    for _ in range(20):
        assert session.step()
    snapshot = make_snapshot(session)

    tampered = copy.deepcopy(snapshot)
    tampered["state"]["integration"][0] += 1
    with pytest.raises(SnapshotIntegrityError, match="snapshotSha256 mismatch"):
        restore_session(tampered, BASELINE, UUID(int=2))

    wrong_size = copy.deepcopy(snapshot)
    wrong_size["manifest"]["stateSize"] = 149
    wrong_size["state"]["integration"] = wrong_size["state"]["integration"][:-1]
    wrong_size["state"]["preStepIntegration"] = wrong_size["state"][
        "preStepIntegration"
    ][:-1]
    _rehash(wrong_size)
    with pytest.raises(
        SnapshotIntegrityError, match="snapshot integration state size does not match"
    ):
        restore_session(wrong_size, BASELINE, UUID(int=2))

    wrong_schema = copy.deepcopy(snapshot)
    wrong_schema["schema"] = "forksafe.sim-snapshot/v2"
    with pytest.raises(SnapshotIntegrityError, match="unsupported snapshot schema"):
        restore_session(wrong_schema, BASELINE, UUID(int=2))

    with pytest.raises(SnapshotMismatchError, match="controller hash"):
        restore_session(snapshot, REFERENCE, UUID(int=2))

    wrong_engine = copy.deepcopy(snapshot)
    wrong_engine["manifest"]["engineVersion"] = "0.0.0"
    _rehash(wrong_engine)
    with pytest.raises(SnapshotMismatchError, match="MuJoCo version"):
        restore_session(wrong_engine, BASELINE, UUID(int=2))


def _cli_environment() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SIMULATOR_ROOT / "services")
    return env


def _cli(*args: str, cwd: Path = SIMULATOR_ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "simulator.cli", *args],
        cwd=cwd,
        env=_cli_environment(),
        capture_output=True,
        text=True,
        check=False,
    )


def test_cli_snapshot_restore_and_unreachable_steps(tmp_path: Path) -> None:
    snapshot_path = tmp_path / "snapshot.json"
    snapshot = _cli(
        "snapshot",
        "--case",
        ORIGINAL.case_id,
        "--at-step",
        "0",
        "--out",
        str(snapshot_path),
    )
    assert snapshot.returncode == 0, snapshot.stderr
    assert snapshot_path.is_file()

    out_dir = tmp_path / "restored"
    restored = _cli(
        "restore",
        "--snapshot",
        str(snapshot_path),
        "--out-dir",
        str(out_dir),
        "--experiment-id",
        str(UUID(int=3)),
    )
    assert restored.returncode == 1, restored.stderr
    result = json.loads((out_dir / "result.json").read_text())
    trace = json.loads((out_dir / "trace.json").read_text())
    assert result["firstFailure"]["kind"] == "forbidden_contact"
    assert result["firstFailure"]["tSec"] == 6.393999999999518
    assert result["firstFailure"]["detail"] == "divider vs geom_82; depthM=0.011595"
    assert trace["restoredFrom"]["stepIndex"] == 0

    unreachable_path = tmp_path / "unreachable.json"
    unreachable = _cli(
        "snapshot",
        "--case",
        ORIGINAL.case_id,
        "--at-step",
        "4000",
        "--out",
        str(unreachable_path),
    )
    assert unreachable.returncode == 2
    assert "terminated at step" in unreachable.stderr
    assert not unreachable_path.exists()

    negative_path = tmp_path / "negative.json"
    negative = _cli(
        "snapshot",
        "--case",
        ORIGINAL.case_id,
        "--at-step",
        "-1",
        "--out",
        str(negative_path),
    )
    assert negative.returncode == 2
    assert not negative_path.exists()


def test_snapshot_step_unreachable_error() -> None:
    session = RunSession.start(BASELINE, ORIGINAL, 0, UUID(int=1))
    session.run_to_end()
    with pytest.raises(SnapshotStepUnreachable):
        make_snapshot(session)
