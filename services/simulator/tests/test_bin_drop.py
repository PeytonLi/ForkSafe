from pathlib import Path
from uuid import UUID

from simulator.models import SimCase
from simulator.runner import run_case
from simulator.scene import build_scene

EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "bin-drop"


def _case() -> SimCase:
    return SimCase.model_validate({
        "caseId": "bin-drop-center",
        "suite": "original",
        "seed": 7,
        "sceneOverrides": {"binWidth": 0.12, "binDx": 0.03},
        "taskFamily": "bin_drop",
    })


def test_bin_drop_scene_builds_an_open_bin() -> None:
    scene = build_scene(_case())
    assert scene.task_family == "bin_drop"
    assert set(scene.geom_ids) >= {"bin_px", "bin_nx", "bin_py", "bin_ny", "cube_geom"}
    assert scene.config["binWidth"] == 0.12
    assert scene.config["target"][0] == scene.config["binCenter"][0]


def test_sample_controller_misses_the_bin() -> None:
    result, _digest = run_case(EXAMPLE, _case(), 7, UUID(int=48))
    assert result["completed"] is False
    assert result["failureKinds"]
