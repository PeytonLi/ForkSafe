from __future__ import annotations

import hashlib
import json

from simulator.runner import SIMULATOR_ROOT, _resolve_case


def test_push_gap_suite_lock_and_case_ids() -> None:
    manifest_path = SIMULATOR_ROOT / "evaluation/push_gap/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    lock = json.loads(
        (SIMULATOR_ROOT / "evaluation/push_gap/suites.lock.json").read_text()
    )
    assert manifest["version"] == "1"
    assert manifest["suiteId"] == "push-gap-public"
    assert manifest["taskFamily"] == "push_through_gap"
    assert hashlib.sha256(manifest_path.read_bytes()).hexdigest() == lock[
        "push-gap-public"
    ]

    push_ids = {case["caseId"] for case in manifest["cases"]}
    divider_ids = set()
    for suite in ("public", "withheld"):
        divider = json.loads(
            (SIMULATOR_ROOT / f"evaluation/{suite}/manifest.json").read_text()
        )
        divider_ids.update(case["caseId"] for case in divider["cases"])
    assert {"push-gap-aligned", "push-gap-offset"} <= push_ids
    assert push_ids.isdisjoint(divider_ids)
    for case_id in push_ids:
        case = _resolve_case(case_id)
        assert case.model_extra["taskFamily"] == "push_through_gap"
