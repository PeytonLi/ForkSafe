from __future__ import annotations

import json
import sys
from pathlib import Path
from uuid import UUID

import pytest
from simulator.models import SimCase
from simulator.runner import SIMULATOR_ROOT, RunSession, run_case
from simulator.scene import build_scene
from simulator.snapshot import make_snapshot, restore_session

PUSH_MANIFEST = SIMULATOR_ROOT / "evaluation/push_gap/manifest.json"
REFERENCE = SIMULATOR_ROOT / "evaluation/push_gap/reference_controller"
BASELINE = SIMULATOR_ROOT / "controllers/push_baseline"


def _cases() -> dict[str, SimCase]:
    manifest = json.loads(PUSH_MANIFEST.read_text())
    return {
        case["caseId"]: SimCase.model_validate(case)
        for case in manifest["cases"]
    }


def test_reference_controller_passes_every_push_case() -> None:
    for case in _cases().values():
        result, _ = run_case(REFERENCE, case, case.seed, UUID(int=40))
        assert result["completed"], (case.case_id, result.get("firstFailure"))
        assert result["failureKinds"] == []


def test_baseline_passes_aligned_and_hits_offset_gap_wall() -> None:
    cases = _cases()
    aligned, _ = run_case(
        BASELINE, cases["push-gap-aligned"], 0, UUID(int=41)
    )
    assert aligned["completed"]
    assert aligned["failureKinds"] == []

    scene = build_scene(cases["push-gap-aligned"])
    assert "divider" not in scene.geom_ids
    assert {"gap_wall_left", "gap_wall_right"} <= scene.geom_ids.keys()

    offset, _ = run_case(
        BASELINE, cases["push-gap-offset"], 0, UUID(int=42)
    )
    assert not offset["completed"]
    assert offset["firstFailure"]["kind"] == "forbidden_contact"
    detail = offset["firstFailure"]["detail"]
    assert "gap_wall_" in detail
    assert "cube_geom" in detail


def test_push_overrides_validate_for_task_family() -> None:
    too_narrow = SimCase(
        caseId="push-too-narrow",
        suite="public",
        taskFamily="push_through_gap",
        seed=0,
        sceneOverrides={"gapWidth": 0.045},
    )
    with pytest.raises(ValueError, match="gapWidth"):
        build_scene(too_narrow)

    divider_override = SimCase(
        caseId="push-divider-override",
        suite="public",
        taskFamily="push_through_gap",
        seed=0,
        sceneOverrides={"dividerHeight": 0.1},
    )
    with pytest.raises(ValueError, match="unknown scene override"):
        build_scene(divider_override)


def test_unknown_task_family_is_invalid_run_through_cli(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    from simulator import cli

    case = SimCase(
        caseId="unknown-family",
        suite="public",
        taskFamily="push_through_wall",
        seed=0,
        sceneOverrides={},
    )
    monkeypatch.setattr(cli, "_resolve_case", lambda _: case)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "simulator.cli",
            "--controller-dir",
            str(REFERENCE),
            "--case-id",
            case.case_id,
            "--seed",
            "0",
            "--out-dir",
            str(tmp_path),
            "--experiment-id",
            str(UUID(int=43)),
        ],
    )
    assert cli.main() == 1
    assert "unknown taskFamily" in capsys.readouterr().err
    result = json.loads((tmp_path / "result.json").read_text())
    assert result["failureKinds"] == ["invalid_run"]
    assert result["firstFailure"]["kind"] == "invalid_run"


def test_push_offset_snapshot_restore_is_bit_identical() -> None:
    case = _cases()["push-gap-offset"]
    session = RunSession.start(REFERENCE, case, 0, UUID(int=44))
    for _ in range(2503):
        assert session.step()
    snapshot = make_snapshot(session)

    session.run_to_end()
    expected_result, expected_trace = session.finish()

    restored = restore_session(snapshot, REFERENCE, UUID(int=45))
    restored.run_to_end()
    restored_result, restored_trace = restored.finish()
    first_time = restored_trace["frames"][0]["tSec"]
    expected_frames = [
        frame for frame in expected_trace["frames"] if frame["tSec"] >= first_time
    ]
    assert restored_trace["frames"] == expected_frames
    assert restored_result["frames"] == expected_frames
    assert restored_trace["finalState"] == expected_trace["finalState"]
    assert restored_trace["attachmentEvents"] == expected_trace["attachmentEvents"]
    assert restored_result["completed"] is True
    assert expected_result["completed"] is True
    assert restored_result.get("completionTimeSec") == expected_result.get(
        "completionTimeSec"
    )
    assert restored_trace["restoredFrom"]["stepIndex"] == 2503
