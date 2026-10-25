from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import numpy as np
import pytest

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


class _InlinePool:
    """Runs fuzz jobs in-process so lattice tests do not start the simulator."""

    def __init__(self, max_workers: int) -> None:
        self.max_workers = max_workers

    def __enter__(self) -> "_InlinePool":
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def map(self, fn: Any, jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        del fn
        echoed = []
        for job in jobs:
            echoed.append(
                {
                    "index": job["index"],
                    "row": job["row"],
                    "col": job["col"],
                    "sceneOverrides": job["sceneOverrides"],
                    "seed": job["seed"],
                    "passed": False,
                    "failureKind": "forbidden_contact",
                    "firstFailureTSec": 0.1,
                    "completionTimeSec": None,
                    "_wallTimeSec": 0.0,
                }
            )
        return echoed


def _historical_axis(low: float, high: float, count: int) -> list[float]:
    step = (high - low) / count
    return [
        float(value)
        for value in np.linspace(low + step / 2, high - step / 2, count)
    ]


def _shift_clamp(
    low: float,
    high: float,
    count: int,
    center: float | None,
    clamp_low: float,
    clamp_high: float,
) -> list[float]:
    values = _historical_axis(low, high, count)
    if center is not None:
        values = [value + (center - (low + high) / 2.0) for value in values]
    return [min(clamp_high, max(clamp_low, value)) for value in values]


def _run_grid(tmp_path: Path, name: str, extra: list[str], *, around: str, n: int = 4) -> dict[str, Any]:
    out = tmp_path / name
    args = [
        "--controller",
        str(BASELINE),
        "--around",
        around,
        "--n",
        str(n),
        "--seed",
        "0",
        "--workers",
        "1",
        "--out",
        str(out),
        *extra,
    ]
    assert fuzz.main(args) == 0
    return json.loads(out.read_text())


def test_center_overrides_shift_divider_and_gap_samples(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fuzz, "ProcessPoolExecutor", _InlinePool)
    plain = _run_grid(tmp_path, "plain.json", [], around="original-divider-collision")
    centered = _run_grid(
        tmp_path,
        "centered.json",
        [
            "--center-overrides",
            json.dumps(
                {
                    "dividerDx": 0.04,
                    "dividerHeight": 0.2,
                    "cubeDx": 0.05,
                    "cubeDy": -0.02,
                    "speedScale": 1.25,
                }
            ),
        ],
        around="original-divider-collision",
    )
    assert plain["cols"] == 2
    assert plain["axes"]["x"]["values"] == pytest.approx([-0.125, 0.125])
    assert plain["axes"]["y"]["values"] == pytest.approx(_historical_axis(0.03, 0.12, 2))
    assert [sample["sceneOverrides"]["dividerDx"] for sample in plain["samples"]] == pytest.approx(
        [-0.125, 0.125, -0.125, 0.125]
    )

    expected_dx = _shift_clamp(-0.25, 0.25, 2, 0.04, -0.10, 0.10)
    expected_height = _shift_clamp(0.03, 0.12, 2, 0.2, 0.02, 0.25)
    assert expected_dx != pytest.approx(plain["axes"]["x"]["values"])
    assert centered["axes"]["x"]["values"] == pytest.approx(expected_dx)
    assert centered["axes"]["y"]["values"] == pytest.approx(expected_height)
    assert centered["axes"]["x"]["values"] != pytest.approx(plain["axes"]["x"]["values"])
    for sample in centered["samples"]:
        column = sample["col"]
        row = sample["row"]
        assert sample["sceneOverrides"]["dividerDx"] == pytest.approx(expected_dx[column])
        assert sample["sceneOverrides"]["dividerHeight"] == pytest.approx(expected_height[row])
        assert sample["sceneOverrides"]["speedScale"] == pytest.approx(1.25)
    for plain_sample, centered_sample in zip(plain["samples"], centered["samples"], strict=True):
        assert centered_sample["sceneOverrides"]["cubeDx"] == pytest.approx(
            plain_sample["sceneOverrides"]["cubeDx"] + 0.05, abs=1.5e-5
        )
        assert centered_sample["sceneOverrides"]["cubeDy"] == pytest.approx(
            plain_sample["sceneOverrides"]["cubeDy"] - 0.02, abs=1.5e-5
        )

    empty = _run_grid(
        tmp_path,
        "empty.json",
        ["--center-overrides", "{}"],
        around="original-divider-collision",
    )
    assert empty["axes"]["x"]["values"] == pytest.approx([-0.10, 0.10])
    assert empty["axes"]["x"]["values"] != pytest.approx(plain["axes"]["x"]["values"])

    nominal = _run_grid(tmp_path, "nominal.json", [], around="nominal")
    assert nominal["axes"]["x"]["values"] == pytest.approx(plain["axes"]["x"]["values"])
    nominal_centered = _run_grid(
        tmp_path,
        "nominal-centered.json",
        ["--center-overrides", json.dumps({"dividerDx": 0.04})],
        around="nominal",
    )
    assert nominal_centered["axes"]["x"]["values"] == pytest.approx(expected_dx)
    nominal_from_case = _run_grid(
        tmp_path,
        "nominal-from-case.json",
        ["--center-overrides", json.dumps({"dividerHeight": 0.2})],
        around="nominal",
    )
    assert nominal_from_case["axes"]["x"]["values"] == pytest.approx(
        _shift_clamp(-0.25, 0.25, 2, 0.3, -0.10, 0.10)
    )

    gap_plain = _run_grid(tmp_path, "gap-plain.json", [], around="push-gap-aligned")
    gap_centered = _run_grid(
        tmp_path,
        "gap-centered.json",
        ["--center-overrides", json.dumps({"gapDx": 0.06, "gapWidth": 0.16})],
        around="push-gap-aligned",
    )
    assert gap_plain["axes"]["x"]["values"] == pytest.approx([-0.04, 0.04])
    assert gap_plain["axes"]["y"]["values"] == pytest.approx(_historical_axis(0.05, 0.10, 2))
    expected_gap_dx = _shift_clamp(-0.08, 0.08, 2, 0.06, -0.10, 0.10)
    expected_gap_width = _shift_clamp(0.05, 0.10, 2, 0.16, 0.05, 0.20)
    assert gap_centered["axes"]["x"]["values"] == pytest.approx(expected_gap_dx)
    assert gap_centered["axes"]["y"]["values"] == pytest.approx(expected_gap_width)
    assert gap_centered["axes"]["x"]["values"] != pytest.approx(gap_plain["axes"]["x"]["values"])
    for sample in gap_centered["samples"]:
        assert sample["sceneOverrides"]["gapDx"] == pytest.approx(expected_gap_dx[sample["col"]])
        assert sample["sceneOverrides"]["gapWidth"] == pytest.approx(expected_gap_width[sample["row"]])
        assert sample["sceneOverrides"]["targetDx"] == pytest.approx(sample["sceneOverrides"]["gapDx"])


def test_center_overrides_reject_invalid_json(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    base = [
        "--controller",
        str(BASELINE),
        "--around",
        "original-divider-collision",
        "--n",
        "1",
        "--workers",
        "1",
    ]
    invalid = [
        "{",
        "[1]",
        '{"dividerDx": "0.04"}',
        '{"dividerDx": true}',
        '{"dividerDx": null}',
        '{"dividerDx": NaN}',
        '{"dividerDx": Infinity}',
    ]
    for raw in invalid:
        result = fuzz.main([*base, "--center-overrides", raw, "--out", str(tmp_path / "bad.json")])
        assert result != 0
        assert "--center-overrides" in capsys.readouterr().err


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
