from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import secrets
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = Path(__file__).resolve().parent
REFERENCE_CONTROLLER = DIRECTORY / "reference_controller"
BASELINE_CONTROLLER = ROOT / "controllers/toss_baseline"
PUBLIC_PATH = DIRECTORY / "public/manifest.json"
WITHHELD_PATH = DIRECTORY / "withheld/manifest.json"
LOCK_PATH = DIRECTORY / "suites.lock.json"
DOMAIN = {
    "objectDx": [-0.08, 0.08],
    "objectDy": [-0.08, 0.08],
    "binDx": [-0.15, 0.05],
    "binDy": [-0.2, 0.2],
    "objectMass": [0.01, 0.5],
    "binWallHeight": [0.03, 0.15],
    "speedScale": [0.5, 1.5],
}

spec = importlib.util.spec_from_file_location(
    "forksafe_suite_helpers", ROOT / "evaluation/build_suites.py"
)
if spec is None or spec.loader is None:
    raise ImportError("could not load shared suite construction helpers")
suite_helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite_helpers)
suite_helpers.REFERENCE_CONTROLLER = REFERENCE_CONTROLLER
suite_helpers.WORK_ROOT = ROOT / "var/toss-suite-construction-work"
_sha256 = suite_helpers._sha256
_reference_reaches = suite_helpers._reference_reaches


def _sample(rng: np.random.Generator, case_id: str, suite: str) -> dict[str, object]:
    overrides = {
        key: round(float(rng.uniform(low, high)), 5)
        for key, (low, high) in DOMAIN.items()
    }
    return {
        "caseId": case_id,
        "suite": suite,
        "taskFamily": "toss_into_bin",
        "seed": int(rng.integers(0, 2**31 - 1)),
        "sceneOverrides": overrides,
        "description": "Toss the object into the open-top bin.",
    }


def _reachable(
    candidate: dict[str, object], rng: np.random.Generator
) -> dict[str, object]:
    for attempt in range(100):
        outcome = _reference_reaches(candidate)
        if outcome["passed"]:
            return candidate
        if candidate["caseId"] in {"toss-bin-default", "toss-bin-nominal"}:
            raise RuntimeError(f"{candidate['caseId']} is not reference-reachable: {outcome}")
        candidate = _sample(rng, str(candidate["caseId"]), str(candidate["suite"]))
    raise RuntimeError(f"could not sample a reachable case: {candidate['caseId']}")


def _baseline_reaches(candidate: dict[str, object]) -> bool:
    original = suite_helpers.REFERENCE_CONTROLLER
    suite_helpers.REFERENCE_CONTROLLER = BASELINE_CONTROLLER
    try:
        return bool(_reference_reaches(candidate)["passed"])
    finally:
        suite_helpers.REFERENCE_CONTROLLER = original


def build(
    withheld_out: Path | None = None, withheld_seed: int | None = None
) -> dict[str, list[dict[str, object]]]:
    if withheld_out is None and withheld_seed is not None:
        raise ValueError("--withheld-seed requires --withheld-out")
    if withheld_seed is not None and not 0 <= withheld_seed < 2**64:
        raise ValueError("withheld seed must be an unsigned 64-bit integer")
    if withheld_out is not None and withheld_out.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("--withheld-out must be outside the repository")
    actual_withheld_seed = (
        20260415
        if withheld_out is None
        else secrets.randbits(63)
        if withheld_seed is None
        else withheld_seed
    )
    public_rng = np.random.default_rng(20260604)
    withheld_rng = np.random.default_rng(actual_withheld_seed)
    default = {
        "caseId": "toss-bin-default",
        "suite": "original",
        "taskFamily": "toss_into_bin",
        "seed": 0,
        "sceneOverrides": {},
        "description": "Default scene baseline failure reproduction.",
    }
    nominal = {
        "caseId": "toss-bin-nominal",
        "suite": "public",
        "taskFamily": "toss_into_bin",
        "seed": 0,
        "sceneOverrides": {"binDx": -0.12},
        "description": "Bin moved closer to the fixed-speed baseline toss.",
    }
    for bin_dx in (-0.12, -0.13, -0.14, -0.15):
        nominal["sceneOverrides"]["binDx"] = bin_dx
        if _baseline_reaches(nominal):
            break
    else:
        raise RuntimeError("no baseline-passing nominal scene found in binDx range")
    public_cases = [
        _reachable(default, public_rng),
        _reachable(nominal, public_rng),
    ]
    public_cases.extend(
        _reachable(_sample(public_rng, f"toss-public-{index:02d}", "public"), public_rng)
        for index in range(1, 7)
    )
    withheld_cases = [
        _reachable(
            _sample(withheld_rng, f"withheld-toss-{index:02d}", "withheld"),
            withheld_rng,
        )
        for index in range(1, 7)
    ]
    public_manifest = {
        "version": "1",
        "generatorSeed": 20260604,
        "domain": DOMAIN,
        "cases": public_cases,
    }
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
        PUBLIC_PATH.parent.mkdir(parents=True, exist_ok=True)
        PUBLIC_PATH.write_text(json.dumps(public_manifest, indent=2) + "\n")
        LOCK_PATH.write_text(
            json.dumps(
                {
                    "public": _sha256(PUBLIC_PATH),
                    "withheld": _sha256(WITHHELD_PATH),
                },
                indent=2,
            )
            + "\n"
        )
    return {"public": public_cases, "withheld": withheld_cases}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--withheld-out", type=Path)
    parser.add_argument("--withheld-seed", type=int)
    arguments = parser.parse_args()
    if arguments.withheld_seed is not None and arguments.withheld_out is None:
        parser.error("--withheld-seed requires --withheld-out")
    result = build(arguments.withheld_out, arguments.withheld_seed)
    print(
        json.dumps(
            {
                "publicCases": len(result["public"]),
                "withheldCases": len(result["withheld"]),
                "withheldOut": arguments.withheld_out is not None,
                "withheldSha256": _sha256(
                    arguments.withheld_out or WITHHELD_PATH
                ),
            },
            indent=2,
        )
    )
