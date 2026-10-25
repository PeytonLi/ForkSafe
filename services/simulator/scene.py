from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import mujoco
import numpy as np

from simulator.assets import ASSET_DIR
from simulator.models import SimCase

SCENE_CONFIG_PATH = Path(__file__).with_name("scene_config.json")
PUSH_GAP_CONFIG_PATH = Path(__file__).parent / "scene_configs/push_gap.json"
OVERRIDE_KEYS = {
    "cubeDx",
    "cubeDy",
    "targetDx",
    "targetDy",
    "dividerDx",
    "dividerDy",
    "dividerHeight",
    "speedScale",
}
PUSH_GAP_OVERRIDE_KEYS = {
    "cubeDx",
    "cubeDy",
    "targetDx",
    "targetDy",
    "gapDx",
    "gapWidth",
    "speedScale",
}
BIN_DROP_OVERRIDE_KEYS = {
    "cubeDx",
    "cubeDy",
    "binDx",
    "binDy",
    "binWidth",
    "speedScale",
}
BIN_DROP_CONFIG_PATH = Path(__file__).parent / "scene_configs/bin_drop.json"


@dataclass
class BuiltScene:
    model: mujoco.MjModel
    config: dict[str, object]
    speed_scale: float
    geom_ids: dict[str, int]
    equality_id: int
    tcp_site_id: int
    cube_body_id: int
    cube_geom_id: int
    robot_geom_ids: set[int]
    joint_ids: list[int]
    actuator_ids: list[int]
    home_key_id: int
    task_family: str


def task_family(case: SimCase) -> str:
    extra = case.model_extra or {}
    family = extra.get("taskFamily", "divider_pick_place")
    if not isinstance(family, str) or family not in {
        "divider_pick_place",
        "push_through_gap",
        "bin_drop",
    }:
        raise ValueError(f"unknown taskFamily: {family!r}")
    return family


def _scene_values(
    case: SimCase, base_config: dict[str, object] | None = None
) -> tuple[dict[str, object], float]:
    family = task_family(case)
    if family == "push_through_gap":
        return _push_gap_scene_values(case, base_config)
    if family == "bin_drop":
        return _bin_drop_scene_values(case, base_config)
    unknown = set(case.scene_overrides) - OVERRIDE_KEYS
    if unknown:
        raise ValueError(f"unknown scene override(s): {', '.join(sorted(unknown))}")
    values = (
        json.loads(SCENE_CONFIG_PATH.read_text())
        if base_config is None
        else json.loads(json.dumps(base_config))
    )
    cube = np.asarray(values["cubeStart"], dtype=float)
    target = np.asarray(values["target"], dtype=float)
    divider = np.asarray(values["dividerCenter"], dtype=float)
    for key, offset in (
        ("cubeDx", (0,)),
        ("cubeDy", (1,)),
        ("targetDx", (0,)),
        ("targetDy", (1,)),
        ("dividerDx", (0,)),
        ("dividerDy", (1,)),
    ):
        value = case.scene_overrides.get(key, 0.0)
        if not np.isfinite(value):
            raise ValueError(f"nonfinite scene override: {key}")
        if key.startswith("cube"):
            cube[offset[0]] += value
        elif key.startswith("target"):
            target[offset[0]] += value
        else:
            divider[offset[0]] += value
    height = case.scene_overrides.get("dividerHeight", float(values["dividerHeight"]))
    speed_scale = case.scene_overrides.get("speedScale", 1.0)
    if not np.isfinite(height) or height <= 0 or not np.isfinite(speed_scale) or speed_scale <= 0:
        raise ValueError("dividerHeight and speedScale must be finite and positive")
    values["cubeStart"] = [float(cube[0]), float(cube[1]), float(cube[2])]
    values["target"] = [float(target[0]), float(target[1]), float(target[2])]
    values["dividerCenter"] = [float(divider[0]), float(divider[1])]
    values["dividerHeight"] = float(height)
    return values, float(speed_scale)


def _push_gap_scene_values(
    case: SimCase, base_config: dict[str, object] | None = None
) -> tuple[dict[str, object], float]:
    unknown = set(case.scene_overrides) - PUSH_GAP_OVERRIDE_KEYS
    if unknown:
        raise ValueError(f"unknown scene override(s): {', '.join(sorted(unknown))}")
    values = (
        json.loads(PUSH_GAP_CONFIG_PATH.read_text())
        if base_config is None
        else json.loads(json.dumps(base_config))
    )
    cube = np.asarray(values["cubeStart"], dtype=float)
    target = np.asarray(values["target"], dtype=float)
    gap_center = np.asarray(values["gapCenter"], dtype=float)
    for key, axis, coordinates in (
        ("cubeDx", 0, cube),
        ("cubeDy", 1, cube),
        ("targetDx", 0, target),
        ("targetDy", 1, target),
        ("gapDx", 0, gap_center),
    ):
        offset = case.scene_overrides.get(key, 0.0)
        if not np.isfinite(offset):
            raise ValueError(f"nonfinite scene override: {key}")
        coordinates[axis] += offset
    gap_width = case.scene_overrides.get("gapWidth", float(values["gapWidth"]))
    speed_scale = case.scene_overrides.get("speedScale", 1.0)
    if not np.isfinite(gap_width) or gap_width <= 0.045:
        raise ValueError("gapWidth must be finite and greater than 0.045")
    if not np.isfinite(speed_scale) or speed_scale <= 0:
        raise ValueError("speedScale must be finite and positive")
    wall_start, wall_end = values["wallSpanX"]
    gap_left = gap_center[0] - gap_width / 2
    gap_right = gap_center[0] + gap_width / 2
    if gap_left <= wall_start or gap_right >= wall_end:
        raise ValueError("gap must fit within wallSpanX")
    values["cubeStart"] = [float(value) for value in cube]
    values["target"] = [float(value) for value in target]
    values["gapCenter"] = [float(value) for value in gap_center]
    values["gapWidth"] = float(gap_width)
    return values, float(speed_scale)


def _bin_drop_scene_values(
    case: SimCase, base_config: dict[str, object] | None = None
) -> tuple[dict[str, object], float]:
    unknown = set(case.scene_overrides) - BIN_DROP_OVERRIDE_KEYS
    if unknown:
        raise ValueError(f"unknown scene override(s): {', '.join(sorted(unknown))}")
    values = (
        json.loads(BIN_DROP_CONFIG_PATH.read_text())
        if base_config is None
        else json.loads(json.dumps(base_config))
    )
    cube = np.asarray(values["cubeStart"], dtype=float)
    bin_center = np.asarray(values["binCenter"], dtype=float)
    for key, axis, coordinates in (
        ("cubeDx", 0, cube),
        ("cubeDy", 1, cube),
        ("binDx", 0, bin_center),
        ("binDy", 1, bin_center),
    ):
        offset = case.scene_overrides.get(key, 0.0)
        if not np.isfinite(offset):
            raise ValueError(f"nonfinite scene override: {key}")
        coordinates[axis] += offset
    bin_width = case.scene_overrides.get("binWidth", float(values["binWidth"]))
    speed_scale = case.scene_overrides.get("speedScale", 1.0)
    if not np.isfinite(bin_width) or bin_width < 0.08 or bin_width > 0.20:
        raise ValueError("binWidth must be finite and between 0.08 and 0.20")
    if not np.isfinite(speed_scale) or speed_scale <= 0:
        raise ValueError("speedScale must be finite and positive")
    values["cubeStart"] = [float(value) for value in cube]
    values["binCenter"] = [float(value) for value in bin_center]
    values["target"] = [float(bin_center[0]), float(bin_center[1]), 0.02]
    values["binWidth"] = float(bin_width)
    values["binHeight"] = 0.06
    values["binHalfThickness"] = 0.008
    return values, float(speed_scale)


def build_scene(
    case: SimCase, *, base_config: dict[str, object] | None = None
) -> BuiltScene:
    family = task_family(case)
    values, speed_scale = _scene_values(case, base_config)
    spec = mujoco.MjSpec.from_file(str(ASSET_DIR / "panda.xml"))
    spec.option.timestep = 0.002

    spec.worldbody.add_geom(
        name="floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[0, 0, 0.1],
        rgba=[0.82, 0.84, 0.86, 1],
    )
    hand = spec.body("hand")
    if hand is None:
        raise ValueError("Panda model has no hand body")
    hand.add_site(name="tcp", pos=[0, 0, 0.1034], size=[0.006])

    cube_pos = values["cubeStart"]
    cube = spec.worldbody.add_body(name="cube", pos=cube_pos)
    cube.add_freejoint(name="cube_free")
    cube.add_geom(
        name="cube_geom",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        size=[0.02, 0.02, 0.02],
        mass=0.1,
        rgba=[0.85, 0.2, 0.12, 1],
        friction=[1.0, 0.005, 0.0001],
    )

    if family == "divider_pick_place":
        divider_x, divider_y = values["dividerCenter"]
        half_length = float(values["dividerHalfLength"])
        half_thickness = float(values["dividerHalfThickness"])
        wall_height = 0.04
        spec.worldbody.add_geom(
            name="divider",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[divider_x, divider_y, float(values["dividerHeight"]) / 2],
            size=[half_length, half_thickness, float(values["dividerHeight"]) / 2],
            rgba=[0.35, 0.38, 0.42, 1],
        )
    elif family == "push_through_gap":
        gap_x, gap_y = values["gapCenter"]
        gap_half_width = float(values["gapWidth"]) / 2
        half_thickness = float(values["wallHalfThickness"])
        wall_height = float(values["wallHeight"])
        wall_start, wall_end = values["wallSpanX"]
        wall_segments = (
            ("gap_wall_left", float(wall_start), gap_x - gap_half_width),
            ("gap_wall_right", gap_x + gap_half_width, float(wall_end)),
        )
        for name, start, end in wall_segments:
            spec.worldbody.add_geom(
                name=name,
                type=mujoco.mjtGeom.mjGEOM_BOX,
                pos=[(start + end) / 2, gap_y, wall_height / 2],
                size=[(end - start) / 2, half_thickness, wall_height / 2],
                rgba=[0.35, 0.38, 0.42, 1],
            )
    else:
        bin_x, bin_y = values["binCenter"]
        half = float(values["binWidth"]) / 2
        thick = float(values["binHalfThickness"])
        wall_height = float(values["binHeight"])
        spec.worldbody.add_geom(
            name="bin_px", type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[bin_x + half, bin_y, wall_height / 2],
            size=[thick, half, wall_height / 2], rgba=[0.2, 0.45, 0.62, 1],
        )
        spec.worldbody.add_geom(
            name="bin_nx", type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[bin_x - half, bin_y, wall_height / 2],
            size=[thick, half, wall_height / 2], rgba=[0.2, 0.45, 0.62, 1],
        )
        spec.worldbody.add_geom(
            name="bin_py", type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[bin_x, bin_y + half, wall_height / 2],
            size=[half, thick, wall_height / 2], rgba=[0.2, 0.45, 0.62, 1],
        )
        spec.worldbody.add_geom(
            name="bin_ny", type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[bin_x, bin_y - half, wall_height / 2],
            size=[half, thick, wall_height / 2], rgba=[0.2, 0.45, 0.62, 1],
        )
    wall_defs = (
        ("wall_near", [0.20, 0, wall_height / 2], [0.01, 0.4, wall_height / 2]),
        ("wall_far", [0.90, 0, wall_height / 2], [0.01, 0.4, wall_height / 2]),
        ("wall_left", [0.55, -0.40, wall_height / 2], [0.35, 0.01, wall_height / 2]),
        ("wall_right", [0.55, 0.40, wall_height / 2], [0.35, 0.01, wall_height / 2]),
    )
    for name, pos, size in wall_defs:
        spec.worldbody.add_geom(
            name=name,
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=pos,
            size=size,
            rgba=[0.45, 0.47, 0.5, 1],
        )

    target = values["target"]
    spec.worldbody.add_site(
        name="target",
        pos=target,
        type=mujoco.mjtGeom.mjGEOM_SPHERE,
        size=[0.025],
        rgba=[0.1, 0.8, 0.25, 0.4],
        group=1,
    )
    marker = spec.worldbody.add_geom(
        name="target_marker",
        type=mujoco.mjtGeom.mjGEOM_SPHERE,
        pos=target,
        size=[0.025],
        contype=0,
        conaffinity=0,
        rgba=[0.1, 0.8, 0.25, 0.4],
    )
    del marker
    equality = spec.add_equality(
        name="grasp_weld",
        type=mujoco.mjtEq.mjEQ_WELD,
        objtype=mujoco.mjtObj.mjOBJ_BODY,
        name1="hand",
        name2="cube",
        active=False,
    )
    equality.data[:3] = [0, 0, 0]
    del equality

    model = spec.compile()
    # Yaw noise is supplied per run by the runner from the same case seed.
    if family == "divider_pick_place":
        geom_names = (
            "floor", "cube_geom", "divider",
            "wall_near", "wall_far", "wall_left", "wall_right",
        )
    elif family == "push_through_gap":
        geom_names = (
            "floor", "cube_geom", "gap_wall_left", "gap_wall_right",
            "wall_near", "wall_far", "wall_left", "wall_right",
        )
    else:
        geom_names = (
            "floor", "cube_geom", "bin_px", "bin_nx", "bin_py", "bin_ny",
            "wall_near", "wall_far", "wall_left", "wall_right",
        )
    geom_ids = {
        name: mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, name)
        for name in geom_names
    }
    body_ids = {
        name: mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, name)
        for name in ("cube", "hand", "link0")
    }
    robot_geom_ids: set[int] = set()
    for geom_id in range(model.ngeom):
        body_id = int(model.geom_bodyid[geom_id])
        while body_id:
            if body_id == body_ids["link0"]:
                robot_geom_ids.add(geom_id)
                break
            body_id = int(model.body_parentid[body_id])

    return BuiltScene(
        model=model,
        config=values,
        speed_scale=speed_scale,
        geom_ids=geom_ids,
        equality_id=mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_EQUALITY, "grasp_weld"),
        tcp_site_id=mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, "tcp"),
        cube_body_id=body_ids["cube"],
        cube_geom_id=geom_ids["cube_geom"],
        robot_geom_ids=robot_geom_ids,
        joint_ids=[
            mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, f"joint{i}")
            for i in range(1, 8)
        ],
        actuator_ids=[
            mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, f"actuator{i}")
            for i in range(1, 9)
        ],
        home_key_id=mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "home"),
        task_family=family,
    )
