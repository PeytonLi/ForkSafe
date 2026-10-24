from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import sys
import time
from pathlib import Path
from typing import Any
from uuid import UUID

import mujoco
import numpy as np

from simulator.assets import verify_assets
from simulator.models import SimCase
from simulator.scene import BuiltScene, build_scene
from simulator.skills import CONTROL_PERIOD, SkillExecutor

SIMULATOR_ROOT = Path(__file__).resolve().parents[2]
PUBLIC_MANIFEST = SIMULATOR_ROOT / "evaluation/public/manifest.json"
FAILURE_KINDS = {
    "forbidden_contact",
    "joint_limit",
    "command_limit",
    "nonfinite_command",
    "stalled",
    "timeout",
    "engine_error",
    "missing_artifact",
    "invalid_run",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_controller(controller_dir: Path) -> tuple[Any, str]:
    controller_path = controller_dir / "task_controller.py"
    controller_hash = _sha256(controller_path)
    spec = importlib.util.spec_from_file_location(
        f"forksafe_controller_{controller_hash[:12]}", controller_path
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load controller at {controller_path}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(controller_dir))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(controller_dir))
    if not callable(getattr(module, "plan", None)):
        raise TypeError("controller must export plan(scene)")
    return module, controller_hash


def _resolve_case(case_id: str) -> SimCase:
    manifest = json.loads(PUBLIC_MANIFEST.read_text())
    for case in manifest["cases"]:
        if case["caseId"] == case_id:
            return SimCase.model_validate(case)
    raise ValueError(f"caseId is not in the public manifest: {case_id}")


def _set_initial_state(scene: BuiltScene, data: mujoco.MjData, seed: int) -> None:
    mujoco.mj_resetDataKeyframe(scene.model, data, scene.home_key_id)
    free_joint = mujoco.mj_name2id(
        scene.model, mujoco.mjtObj.mjOBJ_JOINT, "cube_free"
    )
    address = int(scene.model.jnt_qposadr[free_joint])
    generator = np.random.default_rng(seed)
    data.qpos[address] += generator.uniform(-0.001, 0.001)
    data.qpos[address + 1] += generator.uniform(-0.001, 0.001)
    yaw = generator.uniform(-0.05, 0.05)
    data.qpos[address + 3 : address + 7] = [
        math.cos(yaw / 2),
        0,
        0,
        math.sin(yaw / 2),
    ]
    mujoco.mj_forward(scene.model, data)


def _geom_name(model: mujoco.MjModel, geom_id: int) -> str:
    return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id) or f"geom_{geom_id}"


def _body_name(model: mujoco.MjModel, body_id: int) -> str:
    return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id) or f"body_{body_id}"


def _contact_pairs(scene: BuiltScene) -> tuple[set[tuple[int, int]], set[tuple[int, int]]]:
    barriers = {
        geom_id
        for name, geom_id in scene.geom_ids.items()
        if name in {"divider", "wall_near", "wall_far", "wall_left", "wall_right"}
    }
    forbidden = {
        tuple(sorted((robot_geom, barrier)))
        for robot_geom in scene.robot_geom_ids
        for barrier in barriers
    }
    forbidden.add(tuple(sorted((scene.cube_geom_id, scene.geom_ids["divider"]))))
    hand_body = mujoco.mj_name2id(
        scene.model, mujoco.mjtObj.mjOBJ_BODY, "hand"
    )
    finger_bodies = {
        mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_BODY, "left_finger"),
        mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_BODY, "right_finger"),
    }
    allowed = {
        tuple(sorted((scene.cube_geom_id, scene.geom_ids["floor"]))),
    }
    link0 = mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_BODY, "link0")
    for geom_id in range(scene.model.ngeom):
        body_id = int(scene.model.geom_bodyid[geom_id])
        if body_id == link0:
            allowed.add(tuple(sorted((geom_id, scene.geom_ids["floor"]))))
        if body_id == hand_body or body_id in finger_bodies:
            allowed.add(tuple(sorted((geom_id, scene.cube_geom_id))))
    return allowed, forbidden


def _pair_names(scene: BuiltScene, pairs: set[tuple[int, int]]) -> list[dict[str, Any]]:
    return [
        {"aId": a, "bId": b, "a": _geom_name(scene.model, a), "b": _geom_name(scene.model, b)}
        for a, b in sorted(pairs)
    ]


def _contacts(scene: BuiltScene, data: mujoco.MjData) -> list[dict[str, Any]]:
    return [
        {
            "a": _geom_name(scene.model, int(contact.geom1)),
            "b": _geom_name(scene.model, int(contact.geom2)),
            "depthM": max(0.0, -float(contact.dist)),
        }
        for contact in data.contact[: data.ncon]
    ]


def _controller_scene(scene: BuiltScene, data: mujoco.MjData) -> dict[str, Any]:
    target = scene.config["target"]
    divider = scene.config["dividerCenter"]
    return {
        "cubePos": data.xpos[scene.cube_body_id].copy().tolist(),
        "targetPos": list(target),
        "dividerCenter": list(divider),
        "dividerHeight": float(scene.config["dividerHeight"]),
        "dividerHalfLength": float(scene.config["dividerHalfLength"]),
        "dividerHalfThickness": float(scene.config["dividerHalfThickness"]),
    }


def _frame(scene: BuiltScene, data: mujoco.MjData, executor: SkillExecutor) -> dict[str, Any]:
    bodies = []
    for body_id in range(1, scene.model.nbody):
        bodies.append(
            {
                "name": _body_name(scene.model, body_id),
                "pos": data.xpos[body_id].copy().tolist(),
                "quat": data.xquat[body_id].copy().tolist(),
            }
        )
    return {
        "tSec": float(data.time),
        "qpos": data.qpos.copy().tolist(),
        "qvel": data.qvel.copy().tolist(),
        "ctrl": data.ctrl.copy().tolist(),
        "bodies": bodies,
        "contacts": _contacts(scene, data),
        "cubePos": data.xpos[scene.cube_body_id].copy().tolist(),
        "attached": bool(executor.attached),
        "controllerState": executor.state(),
    }


def _engine_warning(model: mujoco.MjModel, data: mujoco.MjData) -> str | None:
    for warning in data.warning:
        if int(warning.number) > 0:
            return f"MuJoCo warning {warning.number}"
    if not np.all(np.isfinite(data.qpos)) or not np.all(np.isfinite(data.qvel)):
        return "nonfinite qpos or qvel"
    return None


def _joint_limit(scene: BuiltScene, data: mujoco.MjData) -> str | None:
    for joint_id in scene.joint_ids:
        address = int(scene.model.jnt_qposadr[joint_id])
        value = float(data.qpos[address])
        low, high = scene.model.jnt_range[joint_id]
        if value < low - 0.01 or value > high + 0.01:
            name = mujoco.mj_id2name(scene.model, mujoco.mjtObj.mjOBJ_JOINT, joint_id)
            return f"{name}={value:.5f} outside [{low:.5f}, {high:.5f}]"
    return None


def _result(
    experiment_id: UUID,
    frames: list[dict[str, Any]],
    asset_hash: str,
    controller_hash: str,
    *,
    completed: bool = False,
    completion_time: float | None = None,
    failure: tuple[str, float, str] | None = None,
) -> dict[str, Any]:
    result = {
        "experimentId": str(experiment_id),
        "completed": completed,
        "failureKinds": [failure[0]] if failure else [],
        "frames": frames,
        "engineVersion": mujoco.__version__,
        "assetsSha256": asset_hash,
        "controllerSha256": controller_hash,
    }
    if completion_time is not None:
        result["completionTimeSec"] = completion_time
    if failure:
        result["firstFailure"] = {
            "kind": failure[0],
            "tSec": failure[1],
            "detail": failure[2],
        }
    return result


def run_case(
    controller_dir: Path,
    case: SimCase,
    seed: int,
    experiment_id: UUID,
    timeout_sec: float = 30,
) -> tuple[dict[str, Any], dict[str, Any]]:
    start_wall = time.perf_counter()
    asset_hash = verify_assets()
    controller, controller_hash = _load_controller(controller_dir)
    scene = build_scene(case)
    data = mujoco.MjData(scene.model)
    _set_initial_state(scene, data, seed)
    controller_input = _controller_scene(scene, data)
    plan = controller.plan(controller_input)
    if not isinstance(plan, list) or any(not isinstance(skill, dict) for skill in plan):
        raise ValueError("controller plan must return a list of skill objects")
    executor = SkillExecutor(scene, data, plan, scene.speed_scale)
    allowed_pairs, forbidden_pairs = _contact_pairs(scene)
    frames: list[dict[str, Any]] = [_frame(scene, data, executor)]
    counters: dict[tuple[int, int], int] = {}
    failure: tuple[str, float, str] | None = None
    settled_since: float | None = None
    idle_since: float | None = None
    plan_finished_since: float | None = None
    max_time = min(float(timeout_sec), 30.0)
    sample_steps = round(0.1 / scene.model.opt.timestep)
    control_steps = round(CONTROL_PERIOD / scene.model.opt.timestep)
    step_count = 0

    while data.time < max_time:
        if step_count % control_steps == 0:
            try:
                executor.tick(float(data.time))
                executor.maybe_attach(float(data.time))
            except Exception as exc:  # noqa: BLE001
                executor.error = ("invalid_run", f"controller execution failed: {type(exc).__name__}: {exc}")
            if executor.error:
                failure = (executor.error[0], float(data.time), executor.error[1])
                break
        try:
            mujoco.mj_step(scene.model, data)
        except Exception as exc:  # noqa: BLE001
            failure = ("engine_error", float(data.time), f"mj_step raised {type(exc).__name__}: {exc}")
            break
        step_count += 1
        warning = _engine_warning(scene.model, data)
        if warning:
            failure = ("engine_error", float(data.time), warning)
            break
        limit = _joint_limit(scene, data)
        if limit:
            failure = ("joint_limit", float(data.time), limit)
            break

        current_depths: dict[tuple[int, int], float] = {}
        for contact in data.contact[: data.ncon]:
            a, b = int(contact.geom1), int(contact.geom2)
            pair = tuple(sorted((a, b)))
            if pair in forbidden_pairs and -float(contact.dist) > 0.001:
                current_depths[pair] = max(current_depths.get(pair, 0.0), -float(contact.dist))
        for pair in list(counters):
            if pair not in current_depths:
                counters[pair] = 0
        for pair, depth in current_depths.items():
            counters[pair] = counters.get(pair, 0) + 1
            if counters[pair] >= 5:
                failure = (
                    "forbidden_contact",
                    float(data.time),
                    f"{_geom_name(scene.model, pair[0])} vs {_geom_name(scene.model, pair[1])}; depthM={depth:.6f}",
                )
                break
        if failure:
            break

        cube_position = data.xpos[scene.cube_body_id]
        target = np.asarray(scene.config["target"], dtype=float)
        cube_joint = mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_JOINT, "cube_free")
        cube_dof = int(scene.model.jnt_dofadr[cube_joint])
        cube_speed = float(np.linalg.norm(data.qvel[cube_dof : cube_dof + 3]))
        settled = (
            not executor.attached
            and float(np.linalg.norm(cube_position - target)) <= 0.03
            and cube_speed < 0.01
            and abs(float(cube_position[2]) - 0.02) <= 0.005
        )
        if settled:
            if settled_since is None:
                settled_since = float(data.time)
            elif data.time - settled_since >= 0.5:
                if step_count % sample_steps == 0:
                    frames.append(_frame(scene, data, executor))
                completed = True
                completion_time = float(data.time)
                break
        else:
            settled_since = None

        if executor.current_skill is None:
            if plan_finished_since is None:
                plan_finished_since = float(data.time)
            elif data.time - plan_finished_since >= 2.0:
                failure = ("stalled", float(data.time), "plan finished without satisfying completion criteria")
                break
        else:
            plan_finished_since = None

        quiet = float(np.linalg.norm(data.qvel)) < 1e-3 and cube_speed < 1e-3
        if quiet:
            if idle_since is None:
                idle_since = float(data.time)
            elif executor.current_skill is not None and data.time - idle_since >= 3.0:
                failure = ("stalled", float(data.time), "controller and cube remained motionless with plan unfinished")
                break
        else:
            idle_since = None
        if step_count % sample_steps == 0:
            frames.append(_frame(scene, data, executor))
    else:
        failure = ("timeout", float(data.time), f"simulation exceeded {max_time:.3f} seconds")

    if step_count % sample_steps != 0 or (frames and frames[-1]["tSec"] != float(data.time)):
        frames.append(_frame(scene, data, executor))
    if "completed" not in locals():
        completed = False
        completion_time = None
    result = _result(
        experiment_id,
        frames,
        asset_hash,
        controller_hash,
        completed=completed,
        completion_time=completion_time,
        failure=failure,
    )
    geom_id_map = {
        name: geom_id for name, geom_id in scene.geom_ids.items()
    }
    trace = {
        "case": case.model_dump(by_alias=True),
        "sceneConfig": scene.config,
        "geomIds": geom_id_map,
        "allowedPairs": _pair_names(scene, allowed_pairs),
        "forbiddenPairs": _pair_names(scene, forbidden_pairs),
        "mujocoVersion": mujoco.__version__,
        "assetsSha256": asset_hash,
        "controllerSha256": controller_hash,
        "graspModel": "idealized_grasp",
        "frames": frames,
        "attachmentEvents": executor.attachment_events,
        "finalState": {
            "controllerState": executor.state(),
            "simTimeSec": float(data.time),
            "qpos": data.qpos.copy().tolist(),
            "qvel": data.qvel.copy().tolist(),
            "ctrl": data.ctrl.copy().tolist(),
            "completed": completed,
            "failure": result.get("firstFailure"),
        },
        "wallTimeSec": time.perf_counter() - start_wall,
    }
    return result, trace
