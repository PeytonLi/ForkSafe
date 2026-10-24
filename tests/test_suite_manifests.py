from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
_SUITES_SPEC = importlib.util.spec_from_file_location(
    "forksafe_build_suites",
    ROOT / "evaluation/build_suites.py",
)
if _SUITES_SPEC is None or _SUITES_SPEC.loader is None:
    raise RuntimeError("evaluation/build_suites.py is unavailable")
_SUITES_MODULE = importlib.util.module_from_spec(_SUITES_SPEC)
_SUITES_SPEC.loader.exec_module(_SUITES_MODULE)


def test_locked_manifests_have_expected_suite_sizes_and_disjoint_ids():
    lock = json.loads((ROOT / "evaluation/manifests.lock.json").read_text())
    manifests = {}
    for suite in ("public", "withheld"):
        path = ROOT / f"evaluation/{suite}/manifest.json"
        assert hashlib.sha256(path.read_bytes()).hexdigest() == lock[suite]
        manifests[suite] = json.loads(path.read_text())
    public_ids = {case["caseId"] for case in manifests["public"]["cases"]}
    withheld_ids = {case["caseId"] for case in manifests["withheld"]["cases"]}
    assert len(public_ids) == 10
    assert len(withheld_ids) == 8
    assert "original-divider-collision" in public_ids
    assert "nominal" in public_ids
    assert public_ids.isdisjoint(withheld_ids)


def test_simulator_source_does_not_reference_withheld_manifest():
    source = "\n".join(
        path.read_text()
        for path in (ROOT / "services/simulator").rglob("*.py")
    )
    assert "withheld/manifest" not in source


def test_case_sampling_is_deterministic_from_generator_seed():
    first = _SUITES_MODULE._sample_case(np.random.default_rng(123456), "public", "sample")
    second = _SUITES_MODULE._sample_case(np.random.default_rng(123456), "public", "sample")
    assert first == second
