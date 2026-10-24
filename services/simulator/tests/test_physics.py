from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import mujoco
import pytest
from simulator.models import SimCase
from simulator.runner import run_case
from simulator.scene import build_scene
from simulator.skills import SkillExecutor

ROOT = Path(__file__).resolve().parents[3]
BASELINE = ROOT / "controllers/baseline"
REFERENCE = ROOT / "evaluation/reference_controller"


@pytest.fixture(scope="module")
def calibrated_runs():
    original = SimCase(
        caseId="original-divider-collision",
        suite="original",
        seed=0,
        sceneOverrides={},
    )
    public_manifest = json.loads((ROOT / "evaluation/public/manifest.json").read_text())
    nominal = SimCase.model_validate(
        next(case for case in public_manifest["cases"] if case["caseId"] == "nominal")
    )
    return {
        "reference_original": run_case(REFERENCE, original, 0, uuid4()),
        "baseline_nominal": run_case(BASELINE, nominal, nominal.seed, uuid4()),
        "baseline_original": run_case(BASELINE, original, 0, uuid4()),
        "original_case": original,
    }


def test_reference_original_and_baseline_nominal_complete(calibrated_runs):
    reference_result, reference_trace = calibrated_runs["reference_original"]
    nominal_result, nominal_trace = calibrated_runs["baseline_nominal"]
    assert reference_result["completed"]
    assert not reference_result["failureKinds"]
    assert nominal_result["completed"]
    assert not nominal_result["failureKinds"]
    assert reference_trace["attachmentEvents"][0]["attached"]
    assert reference_trace["attachmentEvents"][-1]["attached"] is False
    assert nominal_trace["finalState"]["completed"]


def test_baseline_original_has_real_forbidden_finger_contact(calibrated_runs):
    result, trace = calibrated_runs["baseline_original"]
    assert result["failureKinds"] == ["forbidden_contact"]
    assert result["firstFailure"]["tSec"] > 0
    assert "divider" in result["firstFailure"]["detail"]
    assert trace["frames"][-1]["contacts"]
    scene = build_scene(calibrated_runs["original_case"])
    pair = result["firstFailure"]["detail"].split(";")[0].split(" vs ")
    geom_name = next(name for name in pair if name != "divider")
    geom_id = next(
        geom_id
        for geom_id in range(scene.model.ngeom)
        if (mujoco.mj_id2name(scene.model, mujoco.mjtObj.mjOBJ_GEOM, geom_id) or f"geom_{geom_id}")
        == geom_name
    )
    body_id = int(scene.model.geom_bodyid[geom_id])
    body_name = mujoco.mj_id2name(scene.model, mujoco.mjtObj.mjOBJ_BODY, body_id)
    assert body_name in {"left_finger", "right_finger"}
    assert "depthM=" in result["firstFailure"]["detail"]


def test_idealized_grasp_requires_close_and_proximity():
    case = SimCase(caseId="grasp-gating", suite="public", seed=0, sceneOverrides={})
    scene = build_scene(case)
    data = mujoco.MjData(scene.model)
    mujoco.mj_resetDataKeyframe(scene.model, data, scene.home_key_id)
    mujoco.mj_forward(scene.model, data)
    executor = SkillExecutor(scene, data, [], 1.0)

    executor.close_complete = True
    executor.maybe_attach(0.0)
    assert not executor.attached

    cube_joint = mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_JOINT, "cube_free")
    cube_address = int(scene.model.jnt_qposadr[cube_joint])
    data.qpos[cube_address : cube_address + 3] = data.site_xpos[scene.tcp_site_id]
    mujoco.mj_forward(scene.model, data)
    executor.close_complete = False
    executor.maybe_attach(0.01)
    assert not executor.attached

    executor.close_complete = True
    executor.maybe_attach(0.02)
    assert executor.attached
    executor._gripper({"skill": "open_gripper"}, 0.03)
    assert not executor.attached
    assert not executor.close_complete
