from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import evaluator.run_candidate as evaluator
from evaluator.signing import build_payload

ROOT = Path(__file__).resolve().parents[3]
REFERENCE = ROOT / "evaluation/toss_bin/reference_controller"
TOSS_MANIFEST = ROOT / "evaluation/toss_bin/public/manifest.json"
TOSS_LOCK = ROOT / "evaluation/toss_bin/suites.lock.json"


def _args(tmp_path: Path, *, suite: str, controller: Path = REFERENCE, **overrides):
    controller_path = controller / "task_controller.py"
    controller_sha = hashlib.sha256(
        controller_path.read_bytes()
    ).hexdigest()
    values = {
        "controller": controller_path,
        "bundle": None,
        "expected_sha256": controller_sha,
        "expected_bundle_sha256": None,
        "suite": suite,
        "task_family": "toss_into_bin",
        "out": tmp_path / "result.json",
        "manifest_out": tmp_path / "result.manifest.json",
        "withheld_manifest": None,
        "consume_withheld_manifest": False,
        "candidate_id": uuid4(),
        "investigation_id": uuid4(),
        "evaluator_attempt_id": uuid4(),
        "artifacts_dir": tmp_path / "artifacts",
        "work_dir": tmp_path / "work",
        "case_ids": None,
        "plan_wall_sec": 10,
        "plan_cpu_sec": 10,
        "plan_memory_mb": 1024,
        "case_wall_sec": 180,
        "case_memory_mb": 3072,
        "test_audit_hook_only": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_signed_toss_public_run_binds_toss_lock(monkeypatch, tmp_path):
    monkeypatch.setattr(evaluator, "_make_parent_nondumpable", lambda: True)
    monkeypatch.setattr(evaluator, "_parent_dumpable", lambda: False)
    monkeypatch.setenv(
        "FORKSAFE_EVAL_SIGNING_KEY",
        base64.b64encode(b"toss-evaluator-test-key-00000000").decode("ascii"),
    )
    monkeypatch.delenv("FORKSAFE_REQUIRE_NETNS", raising=False)
    result_code, document = evaluator.run(
        _args(
            tmp_path,
            suite="public",
            case_ids="toss-bin-default",
        )
    )
    assert result_code == 0
    assert document["status"] == "passed"
    assert document["manifestSha256"]["public"] == hashlib.sha256(
        TOSS_MANIFEST.read_bytes()
    ).hexdigest()
    envelope = document["signedManifest"]
    payload = json.loads(base64.b64decode(envelope["payload"]))
    assert payload["manifestsLockSha256"] == hashlib.sha256(
        TOSS_LOCK.read_bytes()
    ).hexdigest()
    assert payload["casesSha256"]


def test_withheld_toss_manifest_is_consumed_and_failure_redacted(
    monkeypatch, tmp_path
):
    manifest_path = tmp_path / "withheld.json"
    manifest = {
        "version": "1",
        "cases": [
            {
                "caseId": "withheld-toss-redaction",
                "suite": "withheld",
                "taskFamily": "toss_into_bin",
                "seed": 0,
                "sceneOverrides": {},
            }
        ],
    }
    raw = json.dumps(manifest, separators=(",", ":")).encode()
    manifest_path.write_bytes(raw)
    lock_path = tmp_path / "suites.lock.json"
    lock_path.write_text(
        json.dumps(
            {
                "public": "0" * 64,
                "withheld": hashlib.sha256(raw).hexdigest(),
            }
        )
    )
    monkeypatch.setattr(evaluator, "TOSS_LOCK_PATH", lock_path)
    empty_controller = tmp_path / "empty-controller"
    empty_controller.mkdir()
    (empty_controller / "task_controller.py").write_text(
        "def plan(scene):\n    return []\n"
    )
    args = _args(
        tmp_path,
        suite="withheld",
        controller=empty_controller,
        withheld_manifest=manifest_path,
        consume_withheld_manifest=True,
    )
    code, document = evaluator.run(args)
    assert code == 1
    assert not manifest_path.exists()
    assert document["cases"][0]["firstFailure"]["detail"] == "redacted: withheld case"
    assert document["firstFailure"]["detail"] == "redacted: withheld case"


def test_toss_manifest_family_mismatch_is_integrity_error(monkeypatch, tmp_path):
    manifest_path = tmp_path / "public.json"
    raw = json.dumps(
        {
            "cases": [
                {
                    "caseId": "wrong-family",
                    "suite": "public",
                    "taskFamily": "divider_pick_place",
                    "seed": 0,
                    "sceneOverrides": {},
                }
            ]
        }
    ).encode()
    manifest_path.write_bytes(raw)
    lock_path = tmp_path / "lock.json"
    lock_path.write_text(
        json.dumps(
            {
                "public": hashlib.sha256(raw).hexdigest(),
                "withheld": "0" * 64,
            }
        )
    )
    monkeypatch.setattr(evaluator, "TOSS_PUBLIC_MANIFEST", manifest_path)
    monkeypatch.setattr(evaluator, "TOSS_LOCK_PATH", lock_path)
    code, document = evaluator.run(
        _args(tmp_path, suite="public", expected_sha256="0" * 64)
    )
    assert code == 3
    assert document["error"]["code"] == "integrity_error"
    assert "taskFamily" in document["error"]["message"]


def test_signed_result_hash_is_canonical_and_order_independent():
    cases = [
        {
            "caseId": f"case-{index}",
            "suite": "public",
            "status": "passed",
            "failureKinds": [],
            "completionTimeSec": 1.25 + index,
            "experimentId": str(uuid4()),
            "traceSha256": "a" * 64,
            "replaySha256": "b" * 64,
        }
        for index in range(2)
    ]
    bundle = SimpleNamespace(bundle_sha256="c" * 64, files={})
    common = {
        "evaluatorCodeSha256": "d" * 64,
        "controllerSha256": "a" * 64,
        "assetsSha256": "e" * 64,
        "engineVersion": "test",
        "manifestSha256": {"public": "f" * 64},
        "candidateId": "candidate",
        "investigationId": "investigation",
        "evaluatorAttemptId": "attempt",
        "status": "passed",
        "exitCode": 0,
        "cases": cases,
        "isolation": {
            "planProcess": "separate_process",
            "network": "audit_hook_only",
            "privilegeDrop": False,
            "parentDumpable": True,
        },
    }
    first = build_payload(
        common,
        bundle=bundle,
        simulator_sha256="1" * 64,
        manifests_lock_sha256="2" * 64,
        case_filter=None,
        key_id="ed25519:test",
    )
    second = build_payload(
        {**common, "cases": list(reversed(cases))},
        bundle=bundle,
        simulator_sha256="1" * 64,
        manifests_lock_sha256="2" * 64,
        case_filter=None,
        key_id="ed25519:test",
    )
    assert first["casesSha256"] == second["casesSha256"]
