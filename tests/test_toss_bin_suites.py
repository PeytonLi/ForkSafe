from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOSS_DIR = ROOT / "evaluation/toss_bin"


def test_toss_suite_manifests_are_locked_and_family_scoped() -> None:
    lock = json.loads((TOSS_DIR / "suites.lock.json").read_text())
    public_path = TOSS_DIR / "public/manifest.json"
    withheld_path = TOSS_DIR / "withheld/manifest.json"
    assert lock == {
        "public": hashlib.sha256(public_path.read_bytes()).hexdigest(),
        "withheld": hashlib.sha256(withheld_path.read_bytes()).hexdigest(),
    }
    public = json.loads(public_path.read_text())
    withheld = json.loads(withheld_path.read_text())
    config = json.loads(
        (ROOT / "services/simulator/scene_configs/toss_bin.json").read_text()
    )
    assert len(public["cases"]) == 8
    assert len(withheld["cases"]) == 6
    assert public["domain"] == config["overrideRanges"]
    assert withheld["domain"] == config["overrideRanges"]
    assert public["cases"][0]["caseId"] == "toss-bin-default"
    assert public["cases"][1]["caseId"] == "toss-bin-nominal"
    assert all(case["taskFamily"] == "toss_into_bin" for case in public["cases"])
    assert all(case["taskFamily"] == "toss_into_bin" for case in withheld["cases"])
    assert all(case["caseId"].startswith("withheld-toss-") for case in withheld["cases"])
