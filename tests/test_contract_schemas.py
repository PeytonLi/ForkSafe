from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import UUID

import pytest
from pydantic import ValidationError
from simulator.models import SimCase, SimFrame, SimRunResult
from simulator.runner import FAILURE_KINDS

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "controllers/baseline"
REFERENCE = ROOT / "evaluation/reference_controller"
PUSH_REFERENCE = ROOT / "evaluation/push_gap/reference_controller"
VALIDATOR = ROOT / "tests/contracts/validate_sim.mts"
CASE_ID = "original-divider-collision"


def _environment() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "services")
    return env


def _simulator_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "simulator.cli", *args],
        cwd=ROOT,
        env=_environment(),
        capture_output=True,
        text=True,
        check=False,
    )


def _tsx(schema: str, path: Path) -> dict[str, object]:
    tsx = ROOT / "node_modules/.bin/tsx"
    command = [str(tsx)]
    if not tsx.exists():
        matches = sorted(
            ROOT.glob("node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs")
        )
        if not matches:
            message = "tsx was not found; run pnpm install before the contract schema tests."
            if os.environ.get("FORKSAFE_REQUIRE_TS_CONTRACTS") == "1":
                pytest.fail(message)
            pytest.skip(message)
        command = ["node", str(matches[0])]
    completed = subprocess.run(
        [*command, str(VALIDATOR), schema, str(path)],
        cwd=ROOT,
        env=_environment(),
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _validate_result(path: Path) -> tuple[dict[str, object], SimRunResult]:
    raw = json.loads(path.read_text())
    python_result = SimRunResult.model_validate(raw)
    typescript = _tsx("result", path)
    assert typescript["valid"], typescript["errors"]
    assert set(typescript["strippedKeys"]) == {"traceRef"}
    python_keys = set(python_result.model_dump(by_alias=True, exclude_none=True))
    typescript_keys = set(typescript["shape"]["keys"])
    assert python_keys - typescript_keys == {"traceRef"}
    assert typescript_keys <= python_keys
    assert not typescript["invalidFailureKinds"]
    assert set(typescript["knownFailureKinds"]) == FAILURE_KINDS
    assert raw["failureKinds"] == python_result.failure_kinds
    return raw, python_result


def _check_frame(frame: dict[str, object], tmp_path: Path) -> None:
    frame_path = tmp_path / "frame.json"
    frame_path.write_text(json.dumps(frame))
    python_frame = SimFrame.model_validate(frame)
    typescript = _tsx("frame", frame_path)
    assert typescript["valid"], typescript["errors"]
    python_keys = set(python_frame.model_dump(by_alias=True, exclude_none=True))
    typescript_keys = set(typescript["shape"]["keys"])
    assert python_keys - typescript_keys == {"controllerState"}
    assert typescript["strippedKeys"] == ["controllerState"]
    assert frame["tSec"] >= 0
    for body in frame["bodies"]:
        assert len(body["pos"]) == 3
        assert all(abs(value) < 2 for value in body["pos"])
        assert len(body["quat"]) == 4
        norm = sum(value * value for value in body["quat"]) ** 0.5
        assert abs(norm - 1) < 1e-6
    for contact in frame["contacts"]:
        assert contact["depthM"] >= 0


def test_typescript_python_sim_contract_agreement(tmp_path: Path) -> None:
    baseline_dir = tmp_path / "baseline"
    baseline = _simulator_cli(
        "--controller-dir",
        str(BASELINE),
        "--case-id",
        CASE_ID,
        "--seed",
        "0",
        "--out-dir",
        str(baseline_dir),
        "--experiment-id",
        str(UUID(int=20)),
    )
    assert baseline.returncode == 1
    stdout_result = json.loads(baseline.stdout)
    assert "traceRef" not in stdout_result
    assert stdout_result["failureKinds"] == ["forbidden_contact"]
    baseline_raw, baseline_python = _validate_result(baseline_dir / "result.json")
    assert baseline_raw["failureKinds"] == ["forbidden_contact"]
    assert baseline_python.completion_time_sec is None

    reference_dir = tmp_path / "reference"
    reference = _simulator_cli(
        "--controller-dir",
        str(REFERENCE),
        "--case-id",
        CASE_ID,
        "--seed",
        "0",
        "--out-dir",
        str(reference_dir),
        "--experiment-id",
        str(UUID(int=21)),
    )
    assert reference.returncode == 0
    reference_raw, reference_python = _validate_result(reference_dir / "result.json")
    assert reference_raw["completed"] is True
    assert reference_python.completion_time_sec is not None

    invalid_dir = tmp_path / "invalid"
    invalid = _simulator_cli(
        "--controller-dir",
        str(tmp_path / "missing-controller"),
        "--case-id",
        CASE_ID,
        "--seed",
        "0",
        "--out-dir",
        str(invalid_dir),
        "--experiment-id",
        str(UUID(int=22)),
    )
    assert invalid.returncode == 1
    invalid_raw, invalid_python = _validate_result(invalid_dir / "result.json")
    assert invalid_raw["failureKinds"] == ["invalid_run"]
    assert invalid_python.first_failure is not None

    snapshot_path = tmp_path / "snapshot.json"
    snapshot = _simulator_cli(
        "snapshot",
        "--case",
        CASE_ID,
        "--at-step",
        "0",
        "--out",
        str(snapshot_path),
    )
    assert snapshot.returncode == 0, snapshot.stderr
    restored_dir = tmp_path / "restored"
    restored = _simulator_cli(
        "restore",
        "--snapshot",
        str(snapshot_path),
        "--out-dir",
        str(restored_dir),
        "--experiment-id",
        str(UUID(int=23)),
    )
    assert restored.returncode == 1
    restored_raw, _ = _validate_result(restored_dir / "result.json")
    assert restored_raw["failureKinds"] == ["forbidden_contact"]
    assert json.loads((restored_dir / "trace.json").read_text())["restoredFrom"]

    push_dir = tmp_path / "push"
    push = _simulator_cli(
        "--controller-dir",
        str(PUSH_REFERENCE),
        "--case-id",
        "push-gap-aligned",
        "--seed",
        "0",
        "--out-dir",
        str(push_dir),
        "--experiment-id",
        str(UUID(int=24)),
    )
    assert push.returncode == 0
    push_raw, push_python = _validate_result(push_dir / "result.json")
    assert push_raw["completed"] is True
    assert push_python.completion_time_sec is not None
    assert json.loads((push_dir / "trace.json").read_text())["case"][
        "taskFamily"
    ] == "push_through_gap"

    for result_dir in (baseline_dir, reference_dir, invalid_dir, restored_dir, push_dir):
        trace = json.loads((result_dir / "trace.json").read_text())
        if trace["frames"]:
            _check_frame(trace["frames"][0], tmp_path)

    case = SimCase.model_validate(
        json.loads((baseline_dir / "trace.json").read_text())["case"]
    )
    case_path = tmp_path / "case.json"
    case_path.write_text(json.dumps(case.model_dump(by_alias=True, exclude_none=True)))
    ts_case = _tsx("case", case_path)
    assert ts_case["valid"], ts_case["errors"]
    assert set(ts_case["shape"]["keys"]) == set(
        case.model_dump(by_alias=True, exclude_none=True)
    )

    invalid_copy = copy.deepcopy(baseline_raw)
    invalid_copy["completed"] = "not-a-boolean"
    invalid_copy["failureKinds"] = ["not-a-failure-kind"]
    invalid_path = tmp_path / "invalid-copy.json"
    invalid_path.write_text(json.dumps(invalid_copy))
    ts_invalid = _tsx("result", invalid_path)
    assert ts_invalid["valid"] is False
    with pytest.raises(ValidationError):
        SimRunResult.model_validate(invalid_copy)
