from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import mujoco
import numpy as np

from simulator.scene import BuiltScene

CONTROL_PERIOD = 0.01
JOINT_COUNT = 7
TCP_TOLERANCE = 0.005
GRASP_DISTANCE = 0.02
TOOL_QUATERNION = np.array([0.0, 1.0, 0.0, 0.0])
TOOL_TRACKING_COMPENSATION = np.array([0.006, 0.0, 0.006])


def _quat_conjugate(quaternion: np.ndarray) -> np.ndarray:
    return np.array([quaternion[0], -quaternion[1], -quaternion[2], -quaternion[3]])


def _rotation_error(desired: np.ndarray, actual: np.ndarray) -> np.ndarray:
    a, b = desired, _quat_conjugate(actual)
    error = np.array(
        [
            a[0] * b[0] - np.dot(a[1:], b[1:]),
            a[0] * b[1] + b[0] * a[1] + a[2] * b[3] - a[3] * b[2],
            a[0] * b[2] + b[0] * a[2] + a[3] * b[1] - a[1] * b[3],
            a[0] * b[3] + b[0] * a[3] + a[1] * b[2] - a[2] * b[1],
        ]
    )
    if error[0] < 0:
        error *= -1
    norm = np.linalg.norm(error[1:])
    if norm < 1e-10:
        return 2.0 * error[1:]
    return 2.0 * math.atan2(norm, max(0.0, error[0])) * error[1:] / norm


class DampedLeastSquaresIK:
    def __init__(self, scene: BuiltScene, data: mujoco.MjData):
        self.scene = scene
        self.model = scene.model
        self.data = mujoco.MjData(self.model)
        self.data.qpos[:] = data.qpos
        self.data.qvel[:] = 0
        mujoco.mj_forward(self.model, self.data)
        self.qpos_addresses = [int(self.model.jnt_qposadr[joint]) for joint in scene.joint_ids]
        self.dof_addresses = [int(self.model.jnt_dofadr[joint]) for joint in scene.joint_ids]
        self.ranges = np.array([self.model.jnt_range[joint] for joint in scene.joint_ids])

    def solve(self, position: np.ndarray) -> np.ndarray:
        jacobian_position = np.zeros((3, self.model.nv))
        jacobian_rotation = np.zeros((3, self.model.nv))
        for _ in range(16):
            mujoco.mj_forward(self.model, self.data)
            current_position = self.data.site_xpos[self.scene.tcp_site_id].copy()
            current_quaternion = np.zeros(4)
            mujoco.mju_mat2Quat(
                current_quaternion,
                self.data.site_xmat[self.scene.tcp_site_id],
            )
            position_error = position - current_position
            rotation_error = _rotation_error(TOOL_QUATERNION, current_quaternion)
            if np.linalg.norm(position_error) < 0.0015 and np.linalg.norm(rotation_error) < 0.025:
                break
            mujoco.mj_jacSite(
                self.model,
                self.data,
                jacobian_position,
                jacobian_rotation,
                self.scene.tcp_site_id,
            )
            jacobian = np.vstack(
                (
                    jacobian_position[:, self.dof_addresses],
                    0.35 * jacobian_rotation[:, self.dof_addresses],
                )
            )
            error = np.concatenate((position_error, 0.35 * rotation_error))
            update = jacobian.T @ np.linalg.solve(
                jacobian @ jacobian.T + 0.04**2 * np.eye(6), error
            )
            update = np.clip(update, -0.10, 0.10)
            for index, address in enumerate(self.qpos_addresses):
                self.data.qpos[address] = np.clip(
                    self.data.qpos[address] + update[index],
                    self.ranges[index, 0] + 0.002,
                    self.ranges[index, 1] - 0.002,
                )
        return np.array([self.data.qpos[address] for address in self.qpos_addresses])


@dataclass
class SkillExecutor:
    scene: BuiltScene
    data: mujoco.MjData
    plan: list[dict[str, Any]]
    speed_scale: float
    index: int = 0
    progress: float = 0.0
    started_at: float | None = None
    move_start: np.ndarray | None = None
    gripper_settled: float = 0.0
    close_complete: bool = False
    attached: bool = False
    attachment_events: list[dict[str, Any]] = field(default_factory=list)
    ik: DampedLeastSquaresIK = field(init=False)
    error: tuple[str, str] | None = None

    def __post_init__(self) -> None:
        self.ik = DampedLeastSquaresIK(self.scene, self.data)

    @property
    def current_skill(self) -> dict[str, Any] | None:
        return self.plan[self.index] if self.index < len(self.plan) else None

    def state(self) -> dict[str, Any]:
        skill = self.current_skill
        return {
            "skillIndex": self.index,
            "skillName": skill.get("skill") if skill else None,
            "skillProgress": float(self.progress),
            "gripperClosedComplete": self.close_complete,
        }

    def _site_position(self) -> np.ndarray:
        return self.data.site_xpos[self.scene.tcp_site_id].copy()

    def _arm_control(self, position: np.ndarray) -> None:
        targets = self.ik.solve(position + TOOL_TRACKING_COMPENSATION)
        for actuator_id, target in zip(self.scene.actuator_ids[:JOINT_COUNT], targets):
            low, high = self.scene.model.actuator_ctrlrange[actuator_id]
            self.data.ctrl[actuator_id] = np.clip(target, low, high)

    def _advance(self) -> None:
        self.index += 1
        self.progress = 0.0
        self.started_at = None
        self.move_start = None
        self.gripper_settled = 0.0

    def _begin(self, time: float) -> None:
        self.started_at = time
        self.move_start = self._site_position()
        self.progress = 0.0

    def _move(self, skill: dict[str, Any], time: float, *, pushing: bool = False) -> None:
        raw_target = skill.get("pos")
        try:
            target = np.asarray(raw_target, dtype=float)
        except (TypeError, ValueError):
            self.error = ("invalid_run", "move target must be a 3D numeric position")
            return
        if target.shape != (3,):
            self.error = ("invalid_run", "move target must contain three coordinates")
            return
        if not np.all(np.isfinite(target)):
            self.error = ("nonfinite_command", "move target contains NaN or infinity")
            return
        if (
            target[0] < 0.2
            or target[0] > 0.85
            or target[1] < -0.4
            or target[1] > 0.4
            or target[2] < 0
            or target[2] > 0.6
        ):
            self.error = ("command_limit", f"target outside workspace: {target.tolist()}")
            return
        default_speed = 0.1 if pushing else 0.25
        try:
            speed = float(skill.get("speed", default_speed)) * self.speed_scale
        except (TypeError, ValueError):
            self.error = ("invalid_run", "move speed must be numeric")
            return
        if not math.isfinite(speed):
            self.error = ("nonfinite_command", "move speed contains NaN or infinity")
            return
        if speed <= 0 or speed > 0.5:
            self.error = ("command_limit", f"move speed outside (0, 0.5]: {speed}")
            return
        if self.started_at is None:
            self._begin(time)
        assert self.started_at is not None and self.move_start is not None
        distance = float(np.linalg.norm(target - self.move_start))
        elapsed = time - self.started_at + CONTROL_PERIOD
        travelled = min(distance, speed * elapsed)
        self.progress = 1.0 if distance == 0 else travelled / distance
        waypoint = self.move_start + (target - self.move_start) * self.progress
        self._arm_control(waypoint)
        if np.linalg.norm(self._site_position() - target) <= TCP_TOLERANCE and travelled >= distance:
            self._advance()
        elif elapsed > distance / speed + 5.0:
            self.error = ("stalled", f"move_to_pose did not reach target {target.tolist()}")

    def _gripper(self, skill: dict[str, Any], time: float) -> None:
        name = skill["skill"]
        is_open = name == "open_gripper"
        actuator = self.scene.actuator_ids[7]
        self.data.ctrl[actuator] = 255.0 if is_open else 0.0
        if self.started_at is None:
            self._begin(time)
            self.gripper_settled = 0.0
            if is_open:
                self.close_complete = False
                if self.attached:
                    self._detach(time)
        finger_velocities = [
            abs(self.data.qvel[self.scene.model.jnt_dofadr[joint]])
            for joint in (
                mujoco.mj_name2id(self.scene.model, mujoco.mjtObj.mjOBJ_JOINT, "finger_joint1"),
                mujoco.mj_name2id(self.scene.model, mujoco.mjtObj.mjOBJ_JOINT, "finger_joint2"),
            )
        ]
        elapsed = time - self.started_at
        if elapsed >= 0.1 and max(finger_velocities) < 0.01:
            self.gripper_settled += CONTROL_PERIOD
        else:
            self.gripper_settled = 0.0
        if self.gripper_settled >= 0.1 or elapsed >= 1.0:
            if not is_open:
                self.close_complete = True
            self._advance()

    def _attach(self, time: float, distance: float) -> None:
        model = self.scene.model
        hand_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "hand")
        hand_position = self.data.xpos[hand_id]
        hand_quaternion = self.data.xquat[hand_id]
        cube_position = self.data.xpos[self.scene.cube_body_id]
        cube_quaternion = self.data.xquat[self.scene.cube_body_id]
        inverse = _quat_conjugate(hand_quaternion)
        relative_quaternion = np.array(
            [
                inverse[0] * cube_quaternion[0] - np.dot(inverse[1:], cube_quaternion[1:]),
                inverse[0] * cube_quaternion[1] + cube_quaternion[0] * inverse[1] + inverse[2] * cube_quaternion[3] - inverse[3] * cube_quaternion[2],
                inverse[0] * cube_quaternion[2] + cube_quaternion[0] * inverse[2] + inverse[3] * cube_quaternion[1] - inverse[1] * cube_quaternion[3],
                inverse[0] * cube_quaternion[3] + cube_quaternion[0] * inverse[3] + inverse[1] * cube_quaternion[2] - inverse[2] * cube_quaternion[1],
            ]
        )
        rotation = np.zeros(9)
        mujoco.mju_quat2Mat(rotation, hand_quaternion)
        local_position = rotation.reshape(3, 3).T @ (cube_position - hand_position)
        row = model.eq_data[self.scene.equality_id]
        row[:3] = 0.0
        row[3:6] = local_position
        row[6:10] = relative_quaternion
        self.data.eq_active[self.scene.equality_id] = 1
        self.attached = True
        self.attachment_events.append(
            {
                "tSec": float(time),
                "attached": True,
                "tcpDistM": float(distance),
                "weldForce": self._weld_force(),
            }
        )

    def _weld_force(self) -> float:
        if not self.data.nefc:
            return 0.0
        mask = (
            (self.data.efc_type == mujoco.mjtConstraint.mjCNSTR_EQUALITY)
            & (self.data.efc_id == self.scene.equality_id)
        )
        return float(np.linalg.norm(self.data.efc_force[mask]))

    def _detach(self, time: float) -> None:
        self.data.eq_active[self.scene.equality_id] = 0
        self.attached = False
        self.attachment_events.append(
            {
                "tSec": float(time),
                "attached": False,
                "tcpDistM": float(
                    np.linalg.norm(
                        self._site_position() - self.data.xpos[self.scene.cube_body_id]
                    )
                ),
                "weldForce": self._weld_force(),
            }
        )

    def tick(self, time: float) -> None:
        skill = self.current_skill
        if skill is None:
            return
        name = skill.get("skill")
        if name in {"move_to_pose", "push"}:
            if name == "push":
                self.data.ctrl[self.scene.actuator_ids[7]] = 0.0
            self._move(skill, time, pushing=name == "push")
        elif name in {"open_gripper", "close_gripper"}:
            self._gripper(skill, time)
        elif name == "wait":
            try:
                duration = float(skill.get("sec"))
            except (TypeError, ValueError):
                self.error = ("invalid_run", "wait duration must be numeric")
                return
            if not math.isfinite(duration):
                self.error = ("nonfinite_command", "wait duration contains NaN or infinity")
                return
            if duration < 0:
                self.error = ("command_limit", "wait duration cannot be negative")
                return
            if self.started_at is None:
                self._begin(time)
            assert self.started_at is not None
            self.progress = 1.0 if duration == 0 else min(1.0, (time - self.started_at) / duration)
            if time - self.started_at >= duration:
                self._advance()
        else:
            self.error = ("command_limit", f"unknown skill: {name!r}")

    def maybe_attach(self, time: float) -> None:
        if self.attached or not self.close_complete:
            return
        distance = float(
            np.linalg.norm(
                self._site_position() - self.data.xpos[self.scene.cube_body_id]
            )
        )
        if distance <= GRASP_DISTANCE:
            self._attach(time, distance)
