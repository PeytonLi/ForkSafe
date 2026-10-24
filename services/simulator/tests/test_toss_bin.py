from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID

import mujoco
import pytest
from simulator.models import SimCase
from simulator.runner import SIMULATOR_ROOT, RunSession, run_case
from simulator.scene import build_scene
from simulator.snapshot import make_snapshot, restore_session
from simulator.skills import SkillExecutor

MANIFEST = SIMULATOR_ROOT / "evaluation/toss_bin/public/manifest.json"
BASELINE = SIMULATOR_ROOT / "controllers/toss_baseline"
REFERENCE = SIMULATOR_ROOT / "evaluation/toss_bin/reference_controller"


def _cases() -> dict[str, SimCase]:
    return {
        item["caseId"]: SimCase.model_validate(item)
        for item in json.loads(MANIFEST.read_text())["cases"]
    }


def test_toss_default_fails_diagnosably_and_reference_passes() -> None:
    default = _cases()["toss-bin-default"]
    baseline, _ = run_case(BASELINE, default, default.seed, UUID(int=46))
    assert baseline["completed"] is False
    assert baseline["firstFailure"]["kind"] in {
        "missed_bin_short",
        "missed_bin_long",
    }
    assert "touchdown" in baseline["firstFailure"]["detail"]
    assert "release speed" in baseline["firstFailure"]["detail"]

    for case in _cases().values():
        result, _ = run_case(REFERENCE, case, case.seed, UUID(int=47))
        assert result["completed"], (case.case_id, result.get("firstFailure"))
        assert result["failureKinds"] == []


def test_toss_scene_overrides_geometry_and_skill_limits() -> None:
    case = SimCase(
        caseId="toss-scene",
        suite="public",
        taskFamily="toss_into_bin",
        seed=0,
        sceneOverrides={"binDx": 0.02, "objectMass": 0.1},
    )
    scene = build_scene(case)
    assert set(scene.geom_ids) == {
        "floor",
        "cube_geom",
        "bin_floor",
        "bin_wall_px",
        "bin_wall_nx",
        "bin_wall_py",
        "bin_wall_ny",
    }
    assert mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_BODY, "bin") > 0
    assert all(
        mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_GEOM, f"wall_{side}") < 0
        for side in ("near", "far", "left", "right")
    )
    for overrides, message in (
        ({"cubeDx": 0.01}, "unknown scene override"),
        ({"objectMass": 0.6}, "objectMass"),
        ({"binDy": float("inf")}, "binDy"),
    ):
        invalid = SimCase(
            caseId="invalid-toss-scene",
            suite="public",
            taskFamily="toss_into_bin",
            seed=0,
            sceneOverrides=overrides,
        )
        with pytest.raises(ValueError, match=message):
            build_scene(invalid)

    data = mujoco.MjData(scene.model)
    executor = SkillExecutor(scene, data, [], 1.0)
    executor.tick(0.0)
    executor.plan = [{"skill": "toss", "pos": [0.83, 0.0, 0.3], "speed": 2.1}]
    executor.index = 0
    executor.tick(0.0)
    assert executor.error == ("command_limit", "move speed outside (0, 2.0]: 2.1")


def test_toss_snapshot_restore_is_bit_identical() -> None:
    case = _cases()["toss-bin-default"]
    session = RunSession.start(REFERENCE, case, 0, UUID(int=48))
    while session.toss_touchdown is None:
        assert session.step()
    for _ in range(30):
        assert session.step()
    snapshot = make_snapshot(session)
    assert snapshot["state"]["loop"]["tossRelease"] is not None
    assert snapshot["state"]["loop"]["tossTouchdown"] is not None

    session.run_to_end()
    expected_result, expected_trace = session.finish()
    restored = restore_session(snapshot, REFERENCE, UUID(int=49))
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
