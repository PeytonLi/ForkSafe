from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from simulator import assets
from simulator.models import SimCase
from simulator.runner import run_case

ROOT = Path(__file__).resolve().parents[3]


def _controller(tmp_path: Path, source: str) -> Path:
    controller_dir = tmp_path / "controller"
    controller_dir.mkdir(parents=True)
    (controller_dir / "task_controller.py").write_text(source)
    return controller_dir


def _run_cli(
    tmp_path: Path,
    controller_dir: Path,
    case: SimCase,
    seed: int,
) -> dict:
    case_path = tmp_path / "case.json"
    case_path.write_text(case.model_dump_json(by_alias=True))
    output_dir = tmp_path / f"run-{uuid4()}"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "services")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "simulator.cli",
            "--controller-dir",
            str(controller_dir),
            "--case-json",
            str(case_path),
            "--seed",
            str(seed),
            "--out-dir",
            str(output_dir),
            "--experiment-id",
            str(uuid4()),
        ],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads((output_dir / "result.json").read_text())


def test_frames_are_deterministic_across_fresh_processes(tmp_path):
    public = json.loads((ROOT / "evaluation/public/manifest.json").read_text())
    nominal = SimCase.model_validate(next(case for case in public["cases"] if case["caseId"] == "nominal"))
    controller = ROOT / "controllers/baseline"
    first = _run_cli(tmp_path, controller, nominal, nominal.seed)
    second = _run_cli(tmp_path, controller, nominal, nominal.seed)
    different_seed = _run_cli(tmp_path, controller, nominal, nominal.seed + 1)

    def frame_bytes(result):
        return json.dumps(result["frames"], sort_keys=True, separators=(",", ":"))

    assert frame_bytes(first) == frame_bytes(second)
    assert frame_bytes(first) != frame_bytes(different_seed)


def test_nonfinite_and_out_of_workspace_commands_are_detected(tmp_path):
    case = SimCase(caseId="command-check", suite="public", seed=0, sceneOverrides={})
    nonfinite = _controller(
        tmp_path / "nonfinite",
        "def plan(scene):\n    return [{'skill': 'move_to_pose', 'pos': [float('nan'), 0.2, 0.2]}]\n",
    )
    out_of_workspace = _controller(
        tmp_path / "workspace",
        "def plan(scene):\n    return [{'skill': 'move_to_pose', 'pos': [0.1, 0.2, 0.2]}]\n",
    )
    result, _ = run_case(nonfinite, case, 0, uuid4())
    assert result["failureKinds"] == ["nonfinite_command"]
    result, _ = run_case(out_of_workspace, case, 0, uuid4())
    assert result["failureKinds"] == ["command_limit"]


def test_noop_and_raising_controllers_fail_closed(tmp_path):
    case = SimCase(caseId="edge-check", suite="public", seed=0, sceneOverrides={})
    noop = _controller(tmp_path / "noop", "def plan(scene):\n    return []\n")
    result, _ = run_case(noop, case, 0, uuid4(), timeout_sec=5)
    assert result["failureKinds"] == ["stalled"]

    raising = _controller(
        tmp_path / "raising",
        "def plan(scene):\n    raise RuntimeError('controller failure')\n",
    )
    cli_result = _run_cli(tmp_path, raising, case, 0)
    assert cli_result["failureKinds"] == ["invalid_run"]


def test_asset_hash_mismatch_is_refused(tmp_path, monkeypatch):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"sha256": "0" * 64}))
    monkeypatch.setattr(assets, "MANIFEST_PATH", manifest)
    with pytest.raises(assets.AssetIntegrityError, match="sha256 mismatch"):
        assets.verify_assets()
