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


def _carry_and_drop_plan(object_start: list[float], bin_center: list[float]) -> list[dict[str, object]]:
    x, y, z = object_start
    return [
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [x, y, z + 0.12], "speed": 0.2},
        {"skill": "move_to_pose", "pos": [x, y, z], "speed": 0.15},
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [x, y, 0.25], "speed": 0.15},
        {"skill": "move_to_pose", "pos": [0.80, bin_center[1], 0.25], "speed": 0.15},
        {"skill": "open_gripper"},
        {"skill": "wait", "sec": 1.0},
    ]


def test_toss_default_fails_diagnosably_and_reference_passes() -> None:
    cases = _cases()
    default = cases["toss-bin-default"]
    baseline, _ = run_case(BASELINE, default, default.seed, UUID(int=46))
    assert baseline["completed"] is False
    assert baseline["firstFailure"]["kind"] in {
        "missed_bin_short",
        "missed_bin_long",
    }
    assert "touchdown" in baseline["firstFailure"]["detail"]
    assert "release speed" in baseline["firstFailure"]["detail"]

    nominal, _ = run_case(
        BASELINE, cases["toss-bin-nominal"], cases["toss-bin-nominal"].seed, UUID(int=48)
    )
    assert nominal["completed"] is True

    for index, case in enumerate(cases.values()):
        result, trace = run_case(REFERENCE, case, case.seed, UUID(int=49 + index))
        assert result["completed"], (case.case_id, result.get("firstFailure"))
        assert result["failureKinds"] == []
        if case.case_id == "toss-bin-default":
            release = next(
                event
                for event in trace["attachmentEvents"]
                if not event["attached"]
            )
            assert release["releaseMode"] == "toss"
            assert release["tcpSpeedMps"] >= 1.4


def test_reference_passes_each_toss_override_extreme_and_far_corners() -> None:
    config = json.loads(
        (SIMULATOR_ROOT / "services/simulator/scene_configs/toss_bin.json").read_text()
    )
    ranges = config["overrideRanges"]
    cases = [
        (key, {key: bound})
        for key, limits in ranges.items()
        for bound in limits
    ]
    bin_dx_max = ranges["binDx"][1]
    cases.extend(
        (
            ("binDx+max/binDy-min", {"binDx": bin_dx_max, "binDy": ranges["binDy"][0]}),
            ("binDx+max/binDy-max", {"binDx": bin_dx_max, "binDy": ranges["binDy"][1]}),
        )
    )
    for index, (name, overrides) in enumerate(cases):
        case = SimCase(
            caseId=f"toss-extreme-{index}",
            suite="public",
            taskFamily="toss_into_bin",
            seed=0,
            sceneOverrides=overrides,
        )
        result, _ = run_case(REFERENCE, case, 0, UUID(int=100 + index))
        assert result["completed"], (name, overrides, result.get("firstFailure"))


def test_carry_and_drop_does_not_complete_default_toss_scene() -> None:
    case = _cases()["toss-bin-default"]
    scene = build_scene(case)
    plan = _carry_and_drop_plan(
        scene.config["objectStart"], scene.config["binCenter"]
    )
    session = RunSession.from_plan(
        case,
        case.seed,
        UUID(int=146),
        plan,
        "0" * 64,
    )
    session.run_to_end()
    result, _ = session.finish()
    assert result["completed"] is False
    assert result["firstFailure"]["kind"] in {"dropped_early", "missed_bin_short"}


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
