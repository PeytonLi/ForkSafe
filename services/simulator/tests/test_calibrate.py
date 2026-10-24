from __future__ import annotations

import os
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

import pytest
from simulator import calibrate as calibration


def test_candidate_order_and_injected_calibration() -> None:
    candidates = calibration.candidate_configs()
    assert len(candidates) == 9
    assert candidates[0]["cubeStart"] == [0.50, -0.15, 0.02]
    assert candidates[0]["target"] == [0.50, 0.15, 0.02]
    assert candidates[1]["cubeStart"] == [0.50, -0.18, 0.02]
    assert candidates[3]["cubeStart"] == [0.45, -0.15, 0.02]

    evaluations = []

    def evaluate(candidate: dict[str, object]) -> dict[str, dict[str, object]]:
        evaluations.append(candidate)
        passed = len(evaluations) > 1
        return {"gate": {"passed": passed, "measured": candidate["cubeStart"][0]}}

    first_config, first_report = calibration.calibrate(evaluate=evaluate)
    evaluations.clear()
    second_config, second_report = calibration.calibrate(evaluate=evaluate)
    assert first_config == second_config == candidates[1]
    assert first_report == second_report
    assert first_report["selectedIndex"] == 1
    assert [entry["index"] for entry in first_report["candidates"]] == [0, 1]
    assert calibration.format_scene_config(first_config) == calibration.format_scene_config(
        second_config
    )
    assert calibration._report_bytes(first_report) == calibration._report_bytes(
        second_report
    )


def test_real_design_pose_passes_calibration_gates() -> None:
    design_pose = calibration.candidate_configs()[0]
    gates = calibration.default_gates(design_pose)
    assert set(gates) == {
        "g1Reachability",
        "g2ReferenceNominal",
        "g3BaselineDividerFailure",
        "g4DividerMoved",
    }
    assert all(gate["passed"] for gate in gates.values()), gates
    config, report = calibration.calibrate()
    assert config == design_pose
    assert report["selectedIndex"] == 0
    assert calibration.format_scene_config(config) == calibration.SCENE_CONFIG_PATH.read_bytes()


def test_all_rejected_is_typed_and_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def reject(_: dict[str, object]) -> dict[str, dict[str, bool]]:
        return {"gate": {"passed": False}}

    output = tmp_path / "scene.json"
    report = tmp_path / "report.json"
    monkeypatch.setattr(
        calibration,
        "_arguments",
        lambda: Namespace(out=output, check=False, report=report),
    )

    original_calibrate = calibration.calibrate

    def fail() -> tuple[dict[str, object], dict[str, object]]:
        original_calibrate(evaluate=reject)
        raise AssertionError("all rejected candidates unexpectedly passed")

    monkeypatch.setattr(calibration, "calibrate", fail)
    assert calibration.main() == 1
    assert not output.exists()
    assert not report.exists()


def test_calibrate_check_cli() -> None:
    root = calibration.SIMULATOR_ROOT
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root / "services")
    completed = subprocess.run(
        [sys.executable, "-m", "simulator.calibrate", "--check"],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
