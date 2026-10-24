from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SERVICES = ROOT / "services"
REFERENCE_CONTROLLER = ROOT / "evaluation/reference_controller"
PUBLIC_PATH = ROOT / "evaluation/public/manifest.json"
WITHHELD_PATH = ROOT / "evaluation/withheld/manifest.json"
LOCK_PATH = ROOT / "evaluation/manifests.lock.json"
WORK_ROOT = ROOT / "var/suite-construction-work"
DOMAIN = {
    "cubeDx": [-0.02, 0.02],
    "cubeDy": [-0.02, 0.02],
    "targetDx": [-0.02, 0.02],
    "targetDy": [-0.02, 0.02],
    "dividerDx": [-0.03, 0.03],
    "dividerDy": [-0.03, 0.03],
    "dividerHeight": [0.08, 0.12],
    "speedScale": [0.8, 1.2],
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _reference_reaches(case: dict[str, object]) -> dict[str, object]:
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=WORK_ROOT) as temporary:
        workspace = Path(temporary)
        case_path = workspace / "case.json"
        output_path = workspace / "artifacts"
        case_path.write_text(json.dumps(case))
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(SERVICES)
        command = [
            sys.executable,
            "-m",
            "simulator.cli",
            "--controller-dir",
            str(REFERENCE_CONTROLLER),
            "--case-json",
            str(case_path),
            "--seed",
            str(case["seed"]),
            "--out-dir",
            str(output_path),
            "--experiment-id",
            str(uuid4()),
            "--timeout-sec",
            "30",
        ]
        completed = subprocess.run(
            command,
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
        )
        result_path = output_path / "result.json"
        trace_path = output_path / "trace.json"
        if not result_path.is_file() or not trace_path.is_file():
            return {
                "passed": False,
                "failureKinds": ["missing_artifact"],
                "detail": (completed.stderr or completed.stdout)[-500:],
            }
        result = json.loads(result_path.read_text())
        return {
            "passed": completed.returncode == 0 and result["completed"] and not result["failureKinds"],
            "failureKinds": result["failureKinds"],
            "completionTimeSec": result.get("completionTimeSec"),
            "controllerSha256": result["controllerSha256"],
            "detail": result.get("firstFailure", {}).get("detail") if result.get("firstFailure") else None,
        }


def _sample_case(
    rng: np.random.Generator,
    suite: str,
    case_id: str,
) -> dict[str, object]:
    overrides = {
        name: round(float(rng.uniform(low, high)), 5)
        for name, (low, high) in DOMAIN.items()
    }
    return {
        "caseId": case_id,
        "suite": suite,
        "seed": int(rng.integers(0, 2**31 - 1)),
        "sceneOverrides": overrides,
    }


def _accepted_case(
    candidate: dict[str, object],
    report: list[dict[str, object]],
) -> dict[str, object]:
    for attempt in range(100):
        outcome = _reference_reaches(candidate)
        report.append(
            {
                "caseId": candidate["caseId"],
                "suite": candidate["suite"],
                "attempt": attempt + 1,
                **outcome,
            }
        )
        if outcome["passed"]:
            return candidate
        if candidate["caseId"] == "nominal":
            raise RuntimeError(f"nominal case is not reference-reachable: {outcome}")
        candidate = dict(candidate)
        candidate.update(_sample_case(
            np.random.default_rng(int(candidate["seed"]) + attempt + 1),
            str(candidate["suite"]),
            str(candidate["caseId"]),
        ))
    raise RuntimeError(f"could not sample a reachable case: {candidate['caseId']}")


def build(
    withheld_out: Path | None = None,
    withheld_seed: int | None = None,
) -> dict[str, list[dict[str, object]]]:
    if withheld_out is None and withheld_seed is not None:
        raise ValueError("--withheld-seed requires --withheld-out")
    if withheld_seed is not None and not 0 <= withheld_seed < 2**64:
        raise ValueError("withheld seed must be an unsigned 64-bit integer")
    if withheld_out is not None and withheld_out.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("--withheld-out must be outside the repository")

    if withheld_out is None:
        actual_withheld_seed = 8182731
    elif withheld_seed is None:
        actual_withheld_seed = secrets.randbits(63)
    else:
        actual_withheld_seed = withheld_seed
    public_report: list[dict[str, object]] = []
    withheld_report: list[dict[str, object]] = []
    public_rng = np.random.default_rng(20260415)
    withheld_rng = np.random.default_rng(actual_withheld_seed)
    original = {
        "caseId": "original-divider-collision",
        "suite": "original",
        "seed": 0,
        "sceneOverrides": {},
        "description": "Default scene baseline failure reproduction.",
    }
    nominal = {
        "caseId": "nominal",
        "suite": "public",
        "seed": int(public_rng.integers(0, 2**31 - 1)),
        "sceneOverrides": {"dividerDx": 0.30},
        "description": "Divider moved out of the cube path.",
    }
    public_cases = [
        _accepted_case(original, public_report),
        _accepted_case(nominal, public_report),
    ]
    for index in range(1, 9):
        candidate = _sample_case(public_rng, "public", f"public-{index:02d}")
        public_cases.append(_accepted_case(candidate, public_report))
    withheld_cases = []
    for index in range(1, 9):
        candidate = _sample_case(withheld_rng, "withheld", f"withheld-{index:02d}")
        withheld_cases.append(_accepted_case(candidate, withheld_report))

    withheld_manifest = {
        "version": "1",
        "generatorSeed": actual_withheld_seed,
        "domain": DOMAIN,
        "cases": withheld_cases,
    }
    withheld_path = withheld_out or WITHHELD_PATH
    withheld_path.parent.mkdir(parents=True, exist_ok=True)
    withheld_path.write_text(json.dumps(withheld_manifest, indent=2) + "\n")
    if withheld_out is None:
        public_manifest = {
            "version": "1",
            "generatorSeed": 20260415,
            "domain": DOMAIN,
            "cases": public_cases,
        }
        PUBLIC_PATH.write_text(json.dumps(public_manifest, indent=2) + "\n")
        lock = {
            "public": _sha256(PUBLIC_PATH),
            "withheld": _sha256(withheld_path),
        }
        LOCK_PATH.write_text(json.dumps(lock, indent=2) + "\n")
    return {"public": public_report, "withheld": withheld_report}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--withheld-out", type=Path)
    parser.add_argument("--withheld-seed", type=int)
    arguments = parser.parse_args()
    if arguments.withheld_seed is not None and arguments.withheld_out is None:
        parser.error("--withheld-seed requires --withheld-out")
    report = build(arguments.withheld_out, arguments.withheld_seed)
    output = {"report": report}
    if arguments.withheld_out is not None:
        output["manifestSha256"] = {
            "public": _sha256(PUBLIC_PATH),
            "withheld": _sha256(arguments.withheld_out),
        }
    print(json.dumps(output if arguments.withheld_out is not None else report, indent=2))
