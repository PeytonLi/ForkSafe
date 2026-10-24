from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import sys
import tempfile
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
PUSH_GAP_MANIFEST = SIMULATOR_ROOT / "evaluation/push_gap/manifest.json"
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


class PlanValidationError(ValueError):
    pass


def finite_json(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: finite_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite_json(item) for item in value]
    return value


def validate_plan(plan: Any) -> list[dict[str, Any]]:
    if not isinstance(plan, list) or len(plan) > 256:
        raise PlanValidationError("plan must be a list of at most 256 skills")

    def validate_value(value: Any, depth: int) -> None:
        if depth > 6:
            raise PlanValidationError("plan nesting depth exceeds 6")
        if value is None or isinstance(value, (bool, int, float, str)):
            return
        if isinstance(value, list):
            for item in value:
                validate_value(item, depth + 1)
            return
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise PlanValidationError("plan object keys must be strings")
            for item in value.values():
                validate_value(item, depth + 1)
            return
        raise PlanValidationError(f"plan contains unsupported value {type(value).__name__}")

    for skill in plan:
        if not isinstance(skill, dict):
            raise PlanValidationError("each plan skill must be an object")
        validate_value(skill, 1)
    try:
        encoded = json.dumps(plan, allow_nan=True, sort_keys=True, separators=(",", ":")).encode()
    except (TypeError, ValueError, RecursionError) as exc:
        raise PlanValidationError(f"plan is not JSON serializable: {type(exc).__name__}") from exc
    if len(encoded) > 64 * 1024:
        raise PlanValidationError("plan exceeds 64 KiB")
    return plan


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
    push_manifest = json.loads(PUSH_GAP_MANIFEST.read_text())
    for case in push_manifest["cases"]:
        if case["caseId"] == case_id:
            return SimCase.model_validate(case)
    raise ValueError(f"caseId is not in the public manifest: {case_id}")


def _set_initial_state(
    scene: BuiltScene,
    data: mujoco.MjData,
    seed: int,
    rng: np.random.Generator | None = None,
) -> None:
    mujoco.mj_resetDataKeyframe(scene.model, data, scene.home_key_id)
    free_joint = mujoco.mj_name2id(
        scene.model, mujoco.mjtObj.mjOBJ_JOINT, "cube_free"
    )
    address = int(scene.model.jnt_qposadr[free_joint])
    generator = rng if rng is not None else np.random.default_rng(seed)
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
    barrier_names = {
        name
        for name in scene.geom_ids
        if name in {"wall_near", "wall_far", "wall_left", "wall_right"}
    }
    barrier_names.update(
        {"gap_wall_left", "gap_wall_right"}
        if scene.task_family == "push_through_gap"
        else {"divider"}
    )
    barriers = {scene.geom_ids[name] for name in barrier_names}
    forbidden = {
        tuple(sorted((robot_geom, barrier)))
        for robot_geom in scene.robot_geom_ids
        for barrier in barriers
    }
    if scene.task_family == "push_through_gap":
        forbidden.update(
            tuple(sorted((scene.cube_geom_id, scene.geom_ids[name])))
            for name in ("gap_wall_left", "gap_wall_right")
        )
    else:
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
    if scene.task_family == "push_through_gap":
        return {
            "taskFamily": scene.task_family,
            "cubePos": data.xpos[scene.cube_body_id].copy().tolist(),
            "targetPos": list(target),
            "gapCenter": list(scene.config["gapCenter"]),
            "gapWidth": float(scene.config["gapWidth"]),
            "wallHeight": float(scene.config["wallHeight"]),
            "wallHalfThickness": float(scene.config["wallHalfThickness"]),
        }
    divider = scene.config["dividerCenter"]
    return {
        "cubePos": data.xpos[scene.cube_body_id].copy().tolist(),
        "targetPos": list(target),
        "dividerCenter": list(divider),
        "dividerHeight": float(scene.config["dividerHeight"]),
        "dividerHalfLength": float(scene.config["dividerHalfLength"]),
        "dividerHalfThickness": float(scene.config["dividerHalfThickness"]),
    }


def controller_input(
    case: SimCase,
    seed: int,
    *,
    base_config: dict[str, object] | None = None,
) -> dict[str, Any]:
    scene = build_scene(case, base_config=base_config)
    data = mujoco.MjData(scene.model)
    _set_initial_state(scene, data, seed)
    return _controller_scene(scene, data)


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


class RunSession:
    def __init__(self) -> None:
        raise TypeError("use RunSession.start() or RunSession.from_plan()")

    @classmethod
    def from_plan(
        cls,
        case: SimCase,
        seed: int,
        experiment_id: UUID,
        plan: list[dict[str, Any]],
        controller_hash: str,
        timeout_sec: float = 30,
        *,
        base_config: dict[str, object] | None = None,
    ) -> RunSession:
        session = cls.__new__(cls)
        session.physics_start_wall = time.perf_counter()
        session.controller_dir: Path | None = None
        session.case = case
        session.seed = int(seed)
        session.experiment_id = experiment_id
        session.asset_hash = verify_assets()
        session.controller_hash = controller_hash
        session.scene = build_scene(case, base_config=base_config)
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "compiled.mjb"
            mujoco.mj_saveModel(session.scene.model, str(model_path))
            session.compiled_model_hash = hashlib.sha256(model_path.read_bytes()).hexdigest()
        session.data = mujoco.MjData(session.scene.model)
        session.rng = np.random.default_rng(seed)
        _set_initial_state(session.scene, session.data, seed, session.rng)
        session.plan = plan
        session.executor = SkillExecutor(
            session.scene, session.data, session.plan, session.scene.speed_scale
        )
        session.allowed_pairs, session.forbidden_pairs = _contact_pairs(session.scene)
        session.frames = [_frame(session.scene, session.data, session.executor)]
        session.counters: dict[tuple[int, int], int] = {}
        session.failure: tuple[str, float, str] | None = None
        session.settled_since: float | None = None
        session.idle_since: float | None = None
        session.plan_finished_since: float | None = None
        session.completed = False
        session.completion_time: float | None = None
        session.max_time = min(float(timeout_sec), 30.0)
        session.sample_steps = round(0.1 / session.scene.model.opt.timestep)
        session.control_steps = round(CONTROL_PERIOD / session.scene.model.opt.timestep)
        session.step_count = 0
        session.pre_step_state = np.zeros(
            mujoco.mj_stateSize(
                session.scene.model, mujoco.mjtState.mjSTATE_INTEGRATION
            ),
            dtype=np.float64,
        )
        session.finished = False
        session.restored_from: dict[str, Any] | None = None
        return session

    @classmethod
    def start(
        cls,
        controller_dir: Path,
        case: SimCase,
        seed: int,
        experiment_id: UUID,
        timeout_sec: float = 30,
        *,
        base_config: dict[str, object] | None = None,
    ) -> RunSession:
        controller_dir = Path(controller_dir)
        controller, controller_hash = _load_controller(controller_dir)
        plan = validate_plan(
            controller.plan(controller_input(case, seed, base_config=base_config))
        )
        session = cls.from_plan(
            case,
            seed,
            experiment_id,
            plan,
            controller_hash,
            timeout_sec,
            base_config=base_config,
        )
        session.controller_dir = controller_dir
        return session

    def step(self) -> bool:
        if self.finished:
            return False
        if not self.data.time < self.max_time:
            self.failure = (
                "timeout",
                float(self.data.time),
                f"simulation exceeded {self.max_time:.3f} seconds",
            )
            self.finished = True
            return False

        if self.step_count % self.control_steps == 0:
            try:
                self.executor.tick(float(self.data.time))
                self.executor.maybe_attach(float(self.data.time))
            except Exception as exc:  # noqa: BLE001
                self.executor.error = (
                    "invalid_run",
                    f"controller execution failed: {type(exc).__name__}: {exc}",
                )
            if self.executor.error:
                self.failure = (
                    self.executor.error[0],
                    float(self.data.time),
                    self.executor.error[1],
                )
                self.finished = True
                return False
        mujoco.mj_getState(
            self.scene.model,
            self.data,
            self.pre_step_state,
            mujoco.mjtState.mjSTATE_INTEGRATION,
        )
        try:
            mujoco.mj_step(self.scene.model, self.data)
        except Exception as exc:  # noqa: BLE001
            self.failure = (
                "engine_error",
                float(self.data.time),
                f"mj_step raised {type(exc).__name__}: {exc}",
            )
            self.finished = True
            return False
        self.step_count += 1
        warning = _engine_warning(self.scene.model, self.data)
        if warning:
            self.failure = ("engine_error", float(self.data.time), warning)
            self.finished = True
            return False
        limit = _joint_limit(self.scene, self.data)
        if limit:
            self.failure = ("joint_limit", float(self.data.time), limit)
            self.finished = True
            return False

        current_depths: dict[tuple[int, int], float] = {}
        for contact in self.data.contact[: self.data.ncon]:
            a, b = int(contact.geom1), int(contact.geom2)
            pair = tuple(sorted((a, b)))
            if pair in self.forbidden_pairs and -float(contact.dist) > 0.001:
                current_depths[pair] = max(
                    current_depths.get(pair, 0.0), -float(contact.dist)
                )
        for pair in list(self.counters):
            if pair not in current_depths:
                self.counters[pair] = 0
        for pair, depth in current_depths.items():
            self.counters[pair] = self.counters.get(pair, 0) + 1
            if self.counters[pair] >= 5:
                self.failure = (
                    "forbidden_contact",
                    float(self.data.time),
                    (
                        f"{_geom_name(self.scene.model, pair[0])} vs "
                        f"{_geom_name(self.scene.model, pair[1])}; depthM={depth:.6f}"
                    ),
                )
                break
        if self.failure:
            self.finished = True
            return False

        cube_position = self.data.xpos[self.scene.cube_body_id]
        target = np.asarray(self.scene.config["target"], dtype=float)
        cube_joint = mujoco.mj_name2id(
            self.scene.model, mujoco.mjtObj.mjOBJ_JOINT, "cube_free"
        )
        cube_dof = int(self.scene.model.jnt_dofadr[cube_joint])
        cube_speed = float(np.linalg.norm(self.data.qvel[cube_dof : cube_dof + 3]))
        settled = (
            not self.executor.attached
            and float(np.linalg.norm(cube_position - target)) <= 0.03
            and cube_speed < 0.01
            and abs(float(cube_position[2]) - 0.02) <= 0.005
        )
        if settled:
            if self.settled_since is None:
                self.settled_since = float(self.data.time)
            elif self.data.time - self.settled_since >= 0.5:
                if self.step_count % self.sample_steps == 0:
                    self.frames.append(_frame(self.scene, self.data, self.executor))
                self.completed = True
                self.completion_time = float(self.data.time)
                self.finished = True
                return False
        else:
            self.settled_since = None

        if self.executor.current_skill is None:
            if self.plan_finished_since is None:
                self.plan_finished_since = float(self.data.time)
            elif self.data.time - self.plan_finished_since >= 2.0:
                self.failure = (
                    "stalled",
                    float(self.data.time),
                    "plan finished without satisfying completion criteria",
                )
                self.finished = True
                return False
        else:
            self.plan_finished_since = None

        quiet = float(np.linalg.norm(self.data.qvel)) < 1e-3 and cube_speed < 1e-3
        if quiet:
            if self.idle_since is None:
                self.idle_since = float(self.data.time)
            elif (
                self.executor.current_skill is not None
                and self.data.time - self.idle_since >= 3.0
            ):
                self.failure = (
                    "stalled",
                    float(self.data.time),
                    "controller and cube remained motionless with plan unfinished",
                )
                self.finished = True
                return False
        else:
            self.idle_since = None
        if self.step_count % self.sample_steps == 0:
            self.frames.append(_frame(self.scene, self.data, self.executor))
        return True

    def run_to_end(self) -> None:
        while self.step():
            pass

    def finish(self) -> tuple[dict[str, Any], dict[str, Any]]:
        if not self.finished:
            self.run_to_end()
        if (
            not self.frames
            or self.step_count % self.sample_steps != 0
            or self.frames[-1]["tSec"] != float(self.data.time)
        ):
            self.frames.append(_frame(self.scene, self.data, self.executor))
        result = _result(
            self.experiment_id,
            self.frames,
            self.asset_hash,
            self.controller_hash,
            completed=self.completed,
            completion_time=self.completion_time,
            failure=self.failure,
        )
        trace = {
            "case": self.case.model_dump(by_alias=True),
            "sceneConfig": self.scene.config,
            "geomIds": {name: geom_id for name, geom_id in self.scene.geom_ids.items()},
            "allowedPairs": _pair_names(self.scene, self.allowed_pairs),
            "forbiddenPairs": _pair_names(self.scene, self.forbidden_pairs),
            "mujocoVersion": mujoco.__version__,
            "assetsSha256": self.asset_hash,
            "controllerSha256": self.controller_hash,
            "graspModel": "idealized_grasp",
            "frames": self.frames,
            "attachmentEvents": self.executor.attachment_events,
            "finalState": {
                "controllerState": self.executor.state(),
                "simTimeSec": float(self.data.time),
                "qpos": self.data.qpos.copy().tolist(),
                "qvel": self.data.qvel.copy().tolist(),
                "ctrl": self.data.ctrl.copy().tolist(),
                "completed": self.completed,
                "failure": result.get("firstFailure"),
            },
        }
        if self.restored_from is not None:
            trace["restoredFrom"] = self.restored_from
        return finite_json(result), finite_json(trace)

    def metrics(self) -> dict[str, Any]:
        physics_wall_sec = time.perf_counter() - self.physics_start_wall
        return {
            "simSteps": self.step_count,
            "simTimeSec": float(self.data.time),
            "physicsWallSec": physics_wall_sec,
            "stepsPerSec": (
                self.step_count / physics_wall_sec if physics_wall_sec else 0.0
            ),
        }


def run_case(
    controller_dir: Path,
    case: SimCase,
    seed: int,
    experiment_id: UUID,
    timeout_sec: float = 30,
) -> tuple[dict[str, Any], dict[str, Any]]:
    controller, controller_hash = _load_controller(controller_dir)
    plan = validate_plan(controller.plan(controller_input(case, seed)))
    result, trace, _ = run_plan(
        case, seed, experiment_id, plan, controller_hash, timeout_sec
    )
    return result, trace


def run_plan(
    case: SimCase,
    seed: int,
    experiment_id: UUID,
    plan: list[dict[str, Any]],
    controller_hash: str,
    timeout_sec: float = 30,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    session = RunSession.from_plan(
        case, seed, experiment_id, plan, controller_hash, timeout_sec
    )
    session.run_to_end()
    result, trace = session.finish()
    return result, trace, session.metrics()


def _run_case_with_config(
    controller_dir: Path,
    case: SimCase,
    seed: int,
    experiment_id: UUID,
    timeout_sec: float = 30,
    *,
    base_config: dict[str, object] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    session = RunSession.start(
        controller_dir,
        case,
        seed,
        experiment_id,
        timeout_sec,
        base_config=base_config,
    )
    session.run_to_end()
    return session.finish()
