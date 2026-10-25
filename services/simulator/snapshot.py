from __future__ import annotations

import hashlib
import json
import os
import platform
import tempfile
import time
from pathlib import Path
from typing import Any
from uuid import UUID

import mujoco
import numpy as np

from simulator.assets import verify_assets
from simulator.models import SimCase
from simulator.runner import RunSession, _contact_pairs, _sha256
from simulator.scene import build_scene
from simulator.skills import CONTROL_PERIOD, SkillExecutor

SNAPSHOT_SCHEMA = "forksafe.sim-snapshot/v1"
STATE_SPEC = mujoco.mjtState.mjSTATE_INTEGRATION
SUCCESS_CRITERIA = {
    "targetTolM": 0.03,
    "settleSpeedMps": 0.01,
    "settleHoldSec": 0.5,
    "cubeZ": 0.02,
    "cubeZTolM": 0.005,
    "forbiddenDepthM": 0.001,
    "forbiddenConsecutiveSteps": 5,
    "stallSec": 2.0,
    "idleSec": 3.0,
}


class SnapshotError(ValueError):
    pass


class SnapshotIntegrityError(SnapshotError):
    pass


class SnapshotMismatchError(SnapshotError):
    pass


class SnapshotStepUnreachable(SnapshotError):
    def __init__(self, terminal_step: int, failure_kind: str | None):
        self.terminal_step = terminal_step
        self.failure_kind = failure_kind
        detail = failure_kind or "completed"
        super().__init__(
            f"snapshot step is unreachable: run terminated at step "
            f"{terminal_step} ({detail})"
        )


def canonical_json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise SnapshotError(f"snapshot contains a non-JSON value: {exc}") from exc


def snapshot_sha256(snapshot_doc: dict[str, Any]) -> str:
    payload = {
        "schema": snapshot_doc["schema"],
        "manifest": snapshot_doc["manifest"],
        "state": snapshot_doc["state"],
    }
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


def make_snapshot(session: RunSession) -> dict[str, Any]:
    if session.finished:
        raise SnapshotStepUnreachable(session.step_count, session.failure[0] if session.failure else None)
    state_size = int(mujoco.mj_stateSize(session.scene.model, STATE_SPEC))
    integration = np.zeros(state_size, dtype=np.float64)
    mujoco.mj_getState(
        session.scene.model,
        session.data,
        integration,
        STATE_SPEC,
    )
    manifest = {
        "stepIndex": session.step_count,
        "simTimeSec": float(session.data.time),
        "timestepSec": float(session.scene.model.opt.timestep),
        "integrator": int(session.scene.model.opt.integrator),
        "engineVersion": mujoco.__version__,
        "numpyVersion": np.__version__,
        "pythonVersion": platform.python_version(),
        "assetsSha256": session.asset_hash,
        "sceneSha256": hashlib.sha256(
            canonical_json_bytes(
                {
                    "sceneConfig": session.scene.config,
                    "speedScale": session.scene.speed_scale,
                    "timestepSec": float(session.scene.model.opt.timestep),
                }
            )
        ).hexdigest(),
        "compiledModelSha256": session.compiled_model_hash,
        "controllerSha256": session.controller_hash,
        "case": session.case.model_dump(by_alias=True),
        "seed": session.seed,
        "graspModel": "idealized_grasp",
        "stateSpec": "mjSTATE_INTEGRATION",
        "stateSize": state_size,
        "successCriteria": {
            **SUCCESS_CRITERIA,
            "maxTimeSec": session.max_time,
        },
    }
    executor = session.executor
    state = {
        "integration": _finite_float_list(integration.tolist()),
        "preStepIntegration": (
            None
            if session.step_count == 0
            else _finite_float_list(session.pre_step_state.tolist())
        ),
        "eqData": _finite_float_list(
            session.scene.model.eq_data[session.scene.equality_id].tolist()
        ),
        "ikQpos": _finite_float_list(executor.ik.data.qpos.tolist()),
        "executor": {
            "index": executor.index,
            "progress": _finite_number(executor.progress),
            "startedAt": executor.started_at,
            "moveStart": (
                None
                if executor.move_start is None
                else _finite_float_list(executor.move_start.tolist())
            ),
            "gripperSettled": _finite_number(executor.gripper_settled),
            "closeComplete": executor.close_complete,
            "attached": executor.attached,
            "tossReleased": executor.toss_released,
            "attachmentEvents": json.loads(json.dumps(executor.attachment_events)),
            "error": list(executor.error) if executor.error is not None else None,
        },
        "plan": json.loads(json.dumps(session.plan)),
        "loop": {
            "stepCount": session.step_count,
            "counters": [
                [a, b, count]
                for (a, b), count in sorted(session.counters.items())
            ],
            "settledSince": session.settled_since,
            "idleSince": session.idle_since,
            "planFinishedSince": session.plan_finished_since,
            "tossRelease": session.toss_release,
            "tossTouchdown": session.toss_touchdown,
            "tossWasInside": session.toss_was_inside,
            "tossRestSince": session.toss_rest_since,
        },
        "rng": {
            "seed": session.seed,
            "bitGenerator": json.loads(json.dumps(session.rng.bit_generator.state)),
        },
    }
    snapshot_doc = {
        "schema": SNAPSHOT_SCHEMA,
        "manifest": manifest,
        "state": state,
    }
    digest = hashlib.sha256(canonical_json_bytes(snapshot_doc)).hexdigest()
    snapshot_doc["snapshotSha256"] = digest
    return snapshot_doc


def _finite_number(value: Any) -> float:
    number = float(value)
    if not np.isfinite(number):
        raise SnapshotError("snapshot contains a non-finite number")
    return number


def _checked_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SnapshotIntegrityError(f"malformed {name}")
    return value


def _checked_float(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SnapshotIntegrityError(f"malformed {name}")
    try:
        return _finite_number(value)
    except (OverflowError, TypeError, ValueError, SnapshotError) as exc:
        raise SnapshotIntegrityError(f"malformed {name}") from exc


def _optional_float(value: Any, name: str) -> float | None:
    return None if value is None else _checked_float(value, name)


def _finite_float_list(values: list[Any]) -> list[float]:
    return [_finite_number(value) for value in values]


def write_snapshot_atomic(snapshot_doc: dict[str, Any], output: Path) -> None:
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(snapshot_doc, indent=2, allow_nan=False).encode("utf-8") + b"\n"
    fd, temporary = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _required_fields(value: Any, fields: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise SnapshotIntegrityError(f"malformed {name} fields")
    return value


def _float_array(value: Any, size: int, name: str) -> np.ndarray:
    if not isinstance(value, list) or len(value) != size:
        raise SnapshotIntegrityError(f"malformed {name} state size")
    if any(
        isinstance(item, bool) or not isinstance(item, (int, float))
        for item in value
    ):
        raise SnapshotIntegrityError(f"malformed {name} values")
    try:
        array = np.asarray(value, dtype=np.float64)
    except (OverflowError, TypeError, ValueError) as exc:
        raise SnapshotIntegrityError(f"malformed {name} values") from exc
    if array.shape != (size,) or not np.all(np.isfinite(array)):
        raise SnapshotIntegrityError(f"malformed {name} values")
    return array


def _validate_snapshot(snapshot_doc: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(snapshot_doc, dict) or snapshot_doc.get("schema") != SNAPSHOT_SCHEMA:
        raise SnapshotIntegrityError("unsupported snapshot schema")
    if set(snapshot_doc) != {"schema", "manifest", "state", "snapshotSha256"}:
        raise SnapshotIntegrityError("malformed snapshot fields")
    manifest = snapshot_doc.get("manifest")
    state = snapshot_doc.get("state")
    if not isinstance(manifest, dict) or not isinstance(state, dict):
        raise SnapshotIntegrityError("malformed snapshot manifest or state")
    digest = snapshot_doc.get("snapshotSha256")
    if not isinstance(digest, str) or len(digest) != 64:
        raise SnapshotIntegrityError("malformed snapshotSha256")
    try:
        actual = snapshot_sha256(snapshot_doc)
    except (KeyError, SnapshotError) as exc:
        raise SnapshotIntegrityError("malformed snapshot content") from exc
    if actual != digest:
        raise SnapshotIntegrityError("snapshotSha256 mismatch")
    manifest_fields = {
        "stepIndex",
        "simTimeSec",
        "timestepSec",
        "integrator",
        "engineVersion",
        "numpyVersion",
        "pythonVersion",
        "assetsSha256",
        "sceneSha256",
        "compiledModelSha256",
        "controllerSha256",
        "case",
        "seed",
        "graspModel",
        "stateSpec",
        "stateSize",
        "successCriteria",
    }
    state_fields = {
        "integration",
        "preStepIntegration",
        "eqData",
        "ikQpos",
        "executor",
        "plan",
        "loop",
        "rng",
    }
    _required_fields(manifest, manifest_fields, "manifest")
    _required_fields(state, state_fields, "state")
    _checked_int(manifest["stepIndex"], "manifest stepIndex")
    _checked_int(manifest["seed"], "manifest seed")
    _checked_int(manifest["integrator"], "manifest integrator")
    state_size = _checked_int(manifest["stateSize"], "manifest stateSize")
    if state_size == 0:
        raise SnapshotIntegrityError("malformed snapshot manifest values")
    _checked_float(manifest["simTimeSec"], "manifest simTimeSec")
    _checked_float(manifest["timestepSec"], "manifest timestepSec")
    if not isinstance(manifest["successCriteria"], dict):
        raise SnapshotIntegrityError("malformed successCriteria")
    if not isinstance(state["plan"], list) or any(
        not isinstance(skill, dict) for skill in state["plan"]
    ):
        raise SnapshotIntegrityError("malformed plan")
    _required_fields(
        state["executor"],
        {
            "index",
            "progress",
            "startedAt",
            "moveStart",
            "gripperSettled",
            "closeComplete",
            "attached",
            "tossReleased",
            "attachmentEvents",
            "error",
        },
        "executor",
    )
    _required_fields(
        state["loop"],
        {
            "stepCount",
            "counters",
            "settledSince",
            "idleSince",
            "planFinishedSince",
            "tossRelease",
            "tossTouchdown",
            "tossWasInside",
            "tossRestSince",
        },
        "loop",
    )
    _required_fields(state["rng"], {"seed", "bitGenerator"}, "rng")
    executor = state["executor"]
    _checked_int(executor["index"], "executor index")
    if executor["index"] > len(state["plan"]):
        raise SnapshotIntegrityError("malformed executor index")
    _checked_float(executor["progress"], "executor progress")
    _optional_float(executor["startedAt"], "executor startedAt")
    _optional_float(executor["gripperSettled"], "executor gripperSettled")
    if executor["moveStart"] is not None:
        _float_array(executor["moveStart"], 3, "moveStart")
    if (
        not isinstance(executor["closeComplete"], bool)
        or not isinstance(executor["attached"], bool)
        or not isinstance(executor["tossReleased"], bool)
        or not isinstance(executor["attachmentEvents"], list)
        or (
            executor["error"] is not None
            and (
                not isinstance(executor["error"], list)
                or len(executor["error"]) != 2
                or any(not isinstance(value, str) for value in executor["error"])
            )
        )
    ):
        raise SnapshotIntegrityError("malformed executor state")
    loop = state["loop"]
    _checked_int(loop["stepCount"], "loop stepCount")
    for key in ("settledSince", "idleSince", "planFinishedSince"):
        _optional_float(loop[key], f"loop {key}")
    for key in ("tossRelease", "tossTouchdown"):
        if loop[key] is not None and not isinstance(loop[key], dict):
            raise SnapshotIntegrityError(f"malformed loop {key}")
    if not isinstance(loop["tossWasInside"], bool):
        raise SnapshotIntegrityError("malformed loop tossWasInside")
    _optional_float(loop["tossRestSince"], "loop tossRestSince")
    if not isinstance(loop["counters"], list):
        raise SnapshotIntegrityError("malformed loop counters")
    _checked_int(state["rng"]["seed"], "RNG seed")
    if not isinstance(state["rng"]["bitGenerator"], dict):
        raise SnapshotIntegrityError("malformed RNG state")
    try:
        canonical_json_bytes({"manifest": manifest, "state": state})
    except SnapshotError as exc:
        raise SnapshotIntegrityError("snapshot contains malformed values") from exc
    return manifest, state


def restore_session(
    snapshot_doc: dict[str, Any], controller_dir: Path, experiment_id: UUID
) -> RunSession:
    manifest, state = _validate_snapshot(snapshot_doc)
    state_size = _checked_int(manifest["stateSize"], "manifest stateSize")
    integration = _float_array(state["integration"], state_size, "integration")
    if integration[0] != manifest["simTimeSec"]:
        raise SnapshotIntegrityError("snapshot time does not match integration state")
    pre_step_value = state["preStepIntegration"]
    if manifest["stepIndex"] == 0:
        if pre_step_value is not None:
            raise SnapshotIntegrityError("preStepIntegration must be null at step 0")
        pre_step = None
    else:
        pre_step = _float_array(pre_step_value, state_size, "preStepIntegration")

    try:
        case = SimCase.model_validate(manifest["case"])
    except (TypeError, ValueError) as exc:
        raise SnapshotIntegrityError("malformed snapshot case") from exc
    controller_path = Path(controller_dir) / "task_controller.py"
    try:
        controller_hash = _sha256(controller_path)
    except OSError as exc:
        raise SnapshotMismatchError("controller task_controller.py is unavailable") from exc
    try:
        asset_hash = verify_assets()
    except Exception as exc:
        raise SnapshotMismatchError("snapshot robot assets are unavailable") from exc
    if asset_hash != manifest["assetsSha256"]:
        raise SnapshotMismatchError("snapshot robot asset hash does not match")
    if controller_hash != manifest["controllerSha256"]:
        raise SnapshotMismatchError("snapshot controller hash does not match")
    if mujoco.__version__ != manifest["engineVersion"]:
        raise SnapshotMismatchError("snapshot MuJoCo version does not match")
    if np.__version__ != manifest["numpyVersion"]:
        raise SnapshotMismatchError("snapshot NumPy version does not match")
    if platform.python_version() != manifest["pythonVersion"]:
        raise SnapshotMismatchError("snapshot Python version does not match")
    if manifest["graspModel"] != "idealized_grasp":
        raise SnapshotMismatchError("snapshot grasp model does not match")
    if manifest["stateSpec"] != "mjSTATE_INTEGRATION":
        raise SnapshotMismatchError("snapshot MuJoCo state specification does not match")

    try:
        scene = build_scene(case)
    except (TypeError, ValueError) as exc:
        raise SnapshotIntegrityError("malformed snapshot scene configuration") from exc
    scene_hash = hashlib.sha256(
        canonical_json_bytes(
            {
                "sceneConfig": scene.config,
                "speedScale": scene.speed_scale,
                "timestepSec": float(scene.model.opt.timestep),
            }
        )
    ).hexdigest()
    if scene_hash != manifest["sceneSha256"]:
        raise SnapshotMismatchError("snapshot scene hash does not match")
    if float(scene.model.opt.timestep) != manifest["timestepSec"]:
        raise SnapshotMismatchError("snapshot timestep does not match")
    with tempfile.TemporaryDirectory() as directory:
        model_path = Path(directory) / "compiled.mjb"
        mujoco.mj_saveModel(scene.model, str(model_path))
        model_hash = hashlib.sha256(model_path.read_bytes()).hexdigest()
    if model_hash != manifest["compiledModelSha256"]:
        raise SnapshotMismatchError("snapshot compiled model hash does not match")
    if int(scene.model.opt.integrator) != manifest["integrator"]:
        raise SnapshotMismatchError("snapshot integrator does not match")
    actual_state_size = int(mujoco.mj_stateSize(scene.model, STATE_SPEC))
    if actual_state_size != state_size:
        raise SnapshotIntegrityError("snapshot integration state size does not match")

    session = RunSession.__new__(RunSession)
    session.physics_start_wall = time.perf_counter()
    session.controller_dir = Path(controller_dir)
    session.case = case
    session.seed = int(manifest["seed"])
    session.experiment_id = experiment_id
    session.asset_hash = asset_hash
    session.controller_hash = controller_hash
    session.compiled_model_hash = model_hash
    session.scene = scene
    session.data = mujoco.MjData(scene.model)
    eq_data = _float_array(state["eqData"], scene.model.eq_data.shape[1], "eqData")
    scene.model.eq_data[scene.equality_id] = eq_data
    if pre_step is not None:
        mujoco.mj_setState(scene.model, session.data, pre_step, STATE_SPEC)
        mujoco.mj_forward(scene.model, session.data)
        mujoco.mj_setState(scene.model, session.data, integration, STATE_SPEC)
    else:
        mujoco.mj_setState(scene.model, session.data, integration, STATE_SPEC)
        mujoco.mj_forward(scene.model, session.data)
    session.plan = state["plan"]
    session.executor = SkillExecutor(scene, session.data, session.plan, scene.speed_scale)
    ik_qpos = _float_array(state["ikQpos"], session.executor.ik.data.qpos.size, "ikQpos")
    session.executor.ik.data.qpos[:] = ik_qpos
    session.executor.ik.data.qvel[:] = 0
    executor_state = state["executor"]
    session.executor.index = _checked_int(executor_state["index"], "executor index")
    session.executor.progress = _checked_float(
        executor_state["progress"], "executor progress"
    )
    session.executor.started_at = _optional_float(
        executor_state["startedAt"], "executor startedAt"
    )
    session.executor.move_start = (
        None
        if executor_state["moveStart"] is None
        else _float_array(executor_state["moveStart"], 3, "moveStart")
    )
    session.executor.gripper_settled = _checked_float(
        executor_state["gripperSettled"], "executor gripperSettled"
    )
    session.executor.close_complete = executor_state["closeComplete"]
    session.executor.attached = executor_state["attached"]
    session.executor.toss_released = executor_state["tossReleased"]
    session.executor.attachment_events = json.loads(
        json.dumps(executor_state["attachmentEvents"])
    )
    error = executor_state["error"]
    session.executor.error = tuple(error) if error is not None else None
    session.allowed_pairs, session.forbidden_pairs = _contact_pairs(scene)
    loop = state["loop"]
    session.counters = {}
    try:
        for row in loop["counters"]:
            if (
                not isinstance(row, list)
                or len(row) != 3
                or any(
                    isinstance(value, bool) or not isinstance(value, int)
                    for value in row
                )
            ):
                raise ValueError
            a, b, count = row
            if count < 0:
                raise ValueError
            session.counters[(a, b)] = count
        session.step_count = _checked_int(loop["stepCount"], "loop stepCount")
        if session.step_count != manifest["stepIndex"]:
            raise ValueError
    except (TypeError, ValueError) as exc:
        raise SnapshotIntegrityError("malformed loop counters") from exc
    session.settled_since = _optional_float(loop["settledSince"], "loop settledSince")
    session.idle_since = _optional_float(loop["idleSince"], "loop idleSince")
    session.plan_finished_since = _optional_float(
        loop["planFinishedSince"], "loop planFinishedSince"
    )
    session.toss_release = json.loads(json.dumps(loop["tossRelease"]))
    session.toss_touchdown = json.loads(json.dumps(loop["tossTouchdown"]))
    session.toss_was_inside = loop["tossWasInside"]
    session.toss_rest_since = _optional_float(loop["tossRestSince"], "loop tossRestSince")
    success_criteria = manifest["successCriteria"]
    if set(success_criteria) != set(SUCCESS_CRITERIA) | {"maxTimeSec"}:
        raise SnapshotIntegrityError("malformed successCriteria fields")
    for key, value in SUCCESS_CRITERIA.items():
        if success_criteria[key] != value:
            raise SnapshotMismatchError(f"snapshot success criterion {key} does not match")
    session.max_time = _checked_float(
        success_criteria["maxTimeSec"], "successCriteria maxTimeSec"
    )
    session.sample_steps = round(0.1 / scene.model.opt.timestep)
    session.control_steps = round(CONTROL_PERIOD / scene.model.opt.timestep)
    session.frames = []
    session.failure = None
    session.completed = False
    session.completion_time = None
    session.pre_step_state = (
        np.zeros(state_size, dtype=np.float64)
        if pre_step is None
        else pre_step.copy()
    )
    session.rng = np.random.default_rng(session.seed)
    if state["rng"]["seed"] != session.seed:
        raise SnapshotIntegrityError("snapshot RNG seed does not match")
    try:
        session.rng.bit_generator.state = state["rng"]["bitGenerator"]
    except (AttributeError, KeyError, OverflowError, TypeError, ValueError) as exc:
        raise SnapshotIntegrityError("malformed RNG state") from exc
    session.finished = False
    session.restored_from = {
        "snapshotSha256": snapshot_doc["snapshotSha256"],
        "stepIndex": session.step_count,
        "simTimeSec": float(session.data.time),
    }
    return session
