from __future__ import annotations

import argparse
import difflib
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID

import mujoco
import numpy as np

from simulator.models import SimCase
from simulator.runner import (
    SIMULATOR_ROOT,
    _controller_scene,
    _load_controller,
    _run_case_with_config,
)
from simulator.scene import SCENE_CONFIG_PATH, build_scene
from simulator.skills import TCP_TOLERANCE, DampedLeastSquaresIK

BASELINE_CONTROLLER = SIMULATOR_ROOT / "controllers/baseline"
REFERENCE_CONTROLLER = SIMULATOR_ROOT / "evaluation/reference_controller"
X_VALUES = (0.50, 0.45, 0.55)
D_VALUES = (0.15, 0.18, 0.12)
DESIGN_DIVIDER_CENTER = [0.5, 0.0]
DESIGN_DIVIDER_HALF_LENGTH = 0.1
DESIGN_DIVIDER_HALF_THICKNESS = 0.01
DESIGN_DIVIDER_HEIGHT = 0.1


class CalibrationError(ValueError):
    pass


def candidate_configs() -> list[dict[str, Any]]:
    base = json.loads(SCENE_CONFIG_PATH.read_text())
    candidates = []
    for x in X_VALUES:
        for distance in D_VALUES:
            config = dict(base)
            config["cubeStart"] = [x, -distance, 0.02]
            config["target"] = [x, distance, 0.02]
            config["dividerCenter"] = DESIGN_DIVIDER_CENTER.copy()
            config["dividerHalfLength"] = DESIGN_DIVIDER_HALF_LENGTH
            config["dividerHalfThickness"] = DESIGN_DIVIDER_HALF_THICKNESS
            config["dividerHeight"] = DESIGN_DIVIDER_HEIGHT
            candidates.append(config)
    return candidates


def _case() -> SimCase:
    return SimCase(
        caseId="original-divider-collision",
        suite="original",
        seed=0,
        sceneOverrides={},
    )


def _reachability_gate(config: dict[str, Any]) -> dict[str, Any]:
    case = _case()
    scene = build_scene(case, base_config=config)
    data = mujoco.MjData(scene.model)
    mujoco.mj_resetDataKeyframe(scene.model, data, scene.home_key_id)
    mujoco.mj_forward(scene.model, data)
    reference_controller, _ = _load_controller(REFERENCE_CONTROLLER)
    plan = reference_controller.plan(_controller_scene(scene, data))
    ik = DampedLeastSquaresIK(scene, data)
    waypoints = [
        np.asarray(skill["pos"], dtype=float)
        for skill in plan
        if skill.get("skill") == "move_to_pose"
    ]
    errors = []
    within_range = True
    for waypoint in waypoints:
        joints = ik.solve(np.asarray(waypoint, dtype=float))
        mujoco.mj_forward(scene.model, ik.data)
        actual = ik.data.site_xpos[scene.tcp_site_id]
        errors.append(float(np.linalg.norm(actual - np.asarray(waypoint, dtype=float))))
        for value, joint_id in zip(joints, scene.joint_ids):
            low, high = scene.model.jnt_range[joint_id]
            if value < low or value > high:
                within_range = False
    max_error = max(errors, default=0.0)
    return {
        "passed": max_error <= TCP_TOLERANCE and within_range,
        "maxErrorM": max_error,
        "jointRangesValid": within_range,
    }


def _run_gate(
    controller: Path,
    config: dict[str, Any],
    case: SimCase,
    *,
    divider_dx: float = 0.0,
) -> dict[str, Any]:
    if divider_dx:
        case = case.model_copy(update={"scene_overrides": {"dividerDx": divider_dx}})
    result, _ = _run_case_with_config(
        controller,
        case,
        case.seed,
        UUID(int=0),
        base_config=config,
    )
    failure = result.get("firstFailure")
    return {
        "completed": result["completed"],
        "completionTimeSec": result.get("completionTimeSec"),
        "failureKinds": result["failureKinds"],
        "failureTSec": failure.get("tSec") if failure else None,
        "failureDetail": failure.get("detail") if failure else None,
    }


def default_gates(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    original = _case()
    g1 = _reachability_gate(config)
    reference = _run_gate(REFERENCE_CONTROLLER, config, original)
    baseline = _run_gate(BASELINE_CONTROLLER, config, original)
    moved = _run_gate(BASELINE_CONTROLLER, config, original, divider_dx=0.30)
    return {
        "g1Reachability": g1,
        "g2ReferenceNominal": {
            **reference,
            "passed": reference["completed"] and not reference["failureKinds"],
        },
        "g3BaselineDividerFailure": {
            **baseline,
            "passed": (
                baseline["failureKinds"] == ["forbidden_contact"]
                and baseline["failureDetail"] is not None
                and "divider" in baseline["failureDetail"]
            ),
        },
        "g4DividerMoved": {
            **moved,
            "passed": moved["completed"] and not moved["failureKinds"],
        },
    }


def calibrate(
    evaluate: Callable[[dict[str, Any]], dict[str, dict[str, Any]]] = default_gates,
) -> tuple[dict[str, Any], dict[str, Any]]:
    attempts = []
    for index, candidate in enumerate(candidate_configs()):
        gates = evaluate(candidate)
        entry = {
            "index": index,
            "candidate": candidate,
            "gates": gates,
        }
        attempts.append(entry)
        if gates and all(
            isinstance(value, dict) and value.get("passed") is True
            for value in gates.values()
        ):
            return candidate, {
                "selectedIndex": index,
                "candidates": attempts,
            }
    raise CalibrationError("all calibration candidates failed their gates")


def format_scene_config(config: dict[str, Any]) -> bytes:
    def number(value: float) -> str:
        return repr(round(float(value), 6))

    cube = ", ".join(number(value) for value in config["cubeStart"])
    target = ", ".join(number(value) for value in config["target"])
    divider = ", ".join(number(value) for value in config["dividerCenter"])
    text = (
        "{\n"
        f'  "cubeStart": [{cube}],\n'
        f'  "target": [{target}],\n'
        f'  "dividerCenter": [{divider}],\n'
        f'  "dividerHalfLength": {number(config["dividerHalfLength"])},\n'
        f'  "dividerHalfThickness": {number(config["dividerHalfThickness"])},\n'
        f'  "dividerHeight": {number(config["dividerHeight"])}\n'
        "}\n"
    )
    return text.encode("utf-8")


def _report_bytes(report: dict[str, Any]) -> bytes:
    return (json.dumps(report, indent=2, allow_nan=False) + "\n").encode("utf-8")


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    try:
        config, report = calibrate()
        output = format_scene_config(config)
        report_content = _report_bytes(report)
    except CalibrationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if args.check:
        committed = SCENE_CONFIG_PATH.read_bytes()
        if output == committed:
            if args.report:
                args.report.write_bytes(report_content)
            return 0
        diff = list(
            difflib.unified_diff(
                committed.decode("utf-8").splitlines(),
                output.decode("utf-8").splitlines(),
                fromfile=str(SCENE_CONFIG_PATH),
                tofile="generated scene_config.json",
                lineterm="",
            )
        )
        print("\n".join(diff[:20]), file=sys.stderr)
        return 1
    if args.out:
        args.out.write_bytes(output)
    else:
        sys.stdout.write(output.decode("utf-8"))
    if args.report:
        args.report.write_bytes(report_content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
