from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

from simulator import fuzz
from simulator.fuzz_svg import render_svg
from simulator.runner import SIMULATOR_ROOT

BASELINE = SIMULATOR_ROOT / "controllers/baseline"


def _fuzz_args(
    *,
    out: Path,
    svg: Path | None = None,
    seed: int = 0,
    workers: int = 1,
    n: int = 8,
) -> list[str]:
    args = [
        "--controller",
        str(BASELINE),
        "--around",
        "original-divider-collision",
        "--n",
        str(n),
        "--seed",
        str(seed),
        "--workers",
        str(workers),
        "--out",
        str(out),
    ]
    if svg is not None:
        args.extend(["--svg", str(svg)])
    return args


def test_fuzz_grid_is_worker_independent_and_svg_is_deterministic(
    tmp_path: Path, capsys
) -> None:
    first_path = tmp_path / "first.json"
    first_svg = tmp_path / "first.svg"
    second_path = tmp_path / "second.json"
    assert fuzz.main(_fuzz_args(out=first_path, svg=first_svg, workers=2)) == 0
    assert fuzz.main(_fuzz_args(out=second_path, workers=1)) == 0
    stderr = capsys.readouterr().err
    assert "sample 0:" in stderr
    assert "total wall time:" in stderr
    assert first_path.read_bytes() == second_path.read_bytes()

    grid = json.loads(first_path.read_text())
    assert grid["schema"] == "forksafe.fuzz-grid/v1"
    assert grid["rows"] == 3
    assert grid["cols"] == 3
    samples = grid["samples"]
    assert len(samples) == 8
    assert grid["summary"]["passCount"] == sum(
        sample["passed"] for sample in samples
    )
    assert grid["summary"]["failCount"] == sum(
        not sample["passed"] for sample in samples
    )
    assert all(
        (sample["failureKind"] is None) == sample["passed"] for sample in samples
    )
    assert first_svg.read_text() == render_svg(grid)
    assert render_svg(grid) == render_svg(json.loads(second_path.read_text()))
    svg_root = ET.fromstring(first_svg.read_text())
    namespace = {"svg": "http://www.w3.org/2000/svg"}
    outcome_rects = svg_root.findall(".//svg:rect[@class='sample']", namespace)
    assert len(outcome_rects) == 8


def test_fuzz_seed_changes_cube_jitter(tmp_path: Path) -> None:
    seed_zero_path = tmp_path / "seed-zero.json"
    seed_one_path = tmp_path / "seed-one.json"
    assert fuzz.main(_fuzz_args(out=seed_zero_path, seed=0, workers=1)) == 0
    assert fuzz.main(_fuzz_args(out=seed_one_path, seed=1, workers=1)) == 0
    zero = json.loads(seed_zero_path.read_text())
    one = json.loads(seed_one_path.read_text())
    zero_jitter = [
        (sample["sceneOverrides"]["cubeDx"], sample["sceneOverrides"]["cubeDy"])
        for sample in zero["samples"]
    ]
    one_jitter = [
        (sample["sceneOverrides"]["cubeDx"], sample["sceneOverrides"]["cubeDy"])
        for sample in one["samples"]
    ]
    assert zero_jitter != one_jitter


def test_toss_fuzz_small_n_uses_toss_axes_and_position_jitter(
    tmp_path: Path, capsys
) -> None:
    output = tmp_path / "toss-grid.json"
    reference = SIMULATOR_ROOT / "evaluation/toss_bin/reference_controller"
    args = [
        "--controller",
        str(reference),
        "--around",
        "toss-bin-default",
        "--n",
        "1",
        "--seed",
        "13",
        "--workers",
        "1",
        "--out",
        str(output),
    ]
    assert fuzz.main(args) == 0
    capsys.readouterr()
    grid = json.loads(output.read_text())
    assert grid["taskFamily"] == "toss_into_bin"
    assert grid["axes"]["x"]["key"] == "binDx"
    assert grid["axes"]["x"]["values"] == [0.0]
    assert grid["axes"]["y"]["key"] == "objectMass"
    overrides = grid["samples"][0]["sceneOverrides"]
    assert set(overrides) == {"binDx", "objectMass", "objectDx", "objectDy"}
    assert -0.01 <= overrides["objectDx"] <= 0.01
    assert -0.01 <= overrides["objectDy"] <= 0.01


def test_fuzz_invalid_n_and_missing_controller_exit_two(tmp_path: Path, capsys) -> None:
    invalid_n = fuzz.main(
        [
            "--controller",
            str(BASELINE),
            "--around",
            "original-divider-collision",
            "--n",
            "0",
        ]
    )
    assert invalid_n == 2

    missing_controller = fuzz.main(
        [
            "--controller",
            str(tmp_path / "missing"),
            "--around",
            "original-divider-collision",
            "--n",
            "1",
        ]
    )
    assert missing_controller == 2
    assert "task_controller.py" in capsys.readouterr().err


def test_fuzz_unknown_case_exits_two(capsys) -> None:
    result = fuzz.main(
        [
            "--controller",
            str(BASELINE),
            "--around",
            "not-a-case",
            "--n",
            "1",
        ]
    )
    assert result == 2
    assert "not in the public manifest" in capsys.readouterr().err
