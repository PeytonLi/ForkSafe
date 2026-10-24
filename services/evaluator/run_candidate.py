from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import re
import resource
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import mujoco
from pydantic import ValidationError
from simulator.assets import verify_assets
from simulator.models import SimCase, SimRunResult
from simulator.runner import finite_json

from evaluator.admission import AdmissionError, AdmittedBundle, admit, materialize
from evaluator.errors import CandidateIntegrityError
from evaluator.models import CandidateEvaluation, CaseEvaluation
from evaluator.sandbox import probe_isolation
from evaluator.signing import (
    SigningKey,
    SigningKeyError,
    build_payload,
    load_signing_key,
    sign_payload,
)

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ROOT / "services"
PUBLIC_MANIFEST = ROOT / "evaluation/public/manifest.json"
LOCK_PATH = ROOT / "evaluation/manifests.lock.json"
CASE_WORKER = Path(__file__).with_name("case_worker.py")
INVALID_FAILURES = {"invalid_run", "engine_error", "missing_artifact"}


class CaseInfrastructureError(RuntimeError):
    pass


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def code_tree_sha256(services_root: Path = SERVICES) -> str:
    digest = hashlib.sha256()
    for path in sorted(services_root.rglob("*.py")):
        if "tests" in path.relative_to(services_root).parts or "__pycache__" in path.parts:
            continue
        digest.update(path.relative_to(services_root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def simulator_tree_sha256(services_root: Path = SERVICES) -> str:
    digest = hashlib.sha256()
    paths = sorted(
        path
        for suffix in ("*.py", "*.json")
        for path in services_root.joinpath("simulator").rglob(suffix)
        if "tests" not in path.relative_to(services_root / "simulator").parts
        and "__pycache__" not in path.parts
    )
    for path in paths:
        digest.update(path.relative_to(services_root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _make_parent_nondumpable() -> bool:
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        return libc.prctl(4, 0, 0, 0, 0) == 0 and not _parent_dumpable()
    except (AttributeError, OSError):
        return False


def _parent_dumpable() -> bool:
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(4, 0, 0, 0, 0) != 0:
            return True
        current = libc.prctl(3, 0, 0, 0, 0)
        return current != 0 if current >= 0 else True
    except (AttributeError, OSError):
        return True


def _manifest_lock() -> dict[str, str]:
    try:
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        if not isinstance(lock, dict):
            raise TypeError("manifest lock must be an object")
        return {"public": str(lock["public"]), "withheld": str(lock["withheld"])}
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CandidateIntegrityError("manifest lock is unavailable or invalid") from exc


def _read_manifest(path: Path, suite: str, expected_sha256: str) -> tuple[dict[str, Any], str]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise CandidateIntegrityError(f"{suite} manifest is unavailable") from exc
    actual_sha = _sha256_bytes(raw)
    if actual_sha != expected_sha256:
        raise CandidateIntegrityError(f"{suite} manifest hash does not match evaluation/manifests.lock.json")
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CandidateIntegrityError(f"{suite} manifest is invalid") from exc
    if not isinstance(manifest, dict) or not isinstance(manifest.get("cases"), list):
        raise CandidateIntegrityError(f"{suite} manifest has an invalid shape")
    return manifest, actual_sha


def _worker_preexec(memory_bytes: int, cpu_sec: int) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_sec, cpu_sec))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(finite_json(value), allow_nan=True, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def execute_case(
    controller_path: Path,
    expected_sha256: str,
    case: dict[str, Any],
    suite: Literal["public", "withheld"],
    evaluator_attempt_id: UUID,
    candidate_id: UUID,
    investigation_id: UUID,
    artifacts_dir: Path,
    *,
    work_dir: Path | None = None,
    plan_wall_sec: float = 10,
    plan_cpu_sec: int = 10,
    plan_memory_mb: int = 1024,
    case_wall_sec: float = 180,
    case_memory_mb: int = 3072,
    require_netns: bool = False,
    test_skip_netns: bool = False,
    bundle: AdmittedBundle | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    admitted = bundle or admit(controller_path)
    if admitted.controller_sha256 != expected_sha256:
        raise CandidateIntegrityError("controller SHA does not match --expected-sha256")

    experiment_id = uuid5(
        NAMESPACE_URL,
        f"{evaluator_attempt_id}:{suite}:{case['caseId']}",
    )
    if work_dir is None:
        work_dir = Path(tempfile.gettempdir())
    work_dir.mkdir(parents=True, exist_ok=True)
    case_id = str(case["caseId"])
    artifacts_dir = artifacts_dir.resolve()
    case_artifacts = artifacts_dir / suite / case_id
    try:
        with tempfile.TemporaryDirectory(prefix="forksafe-case-", dir=work_dir) as temporary:
            case_root = Path(temporary)
            candidate_dir = case_root / "candidate"
            materialize(admitted, candidate_dir)
            candidate_copy = candidate_dir / "task_controller.py"
            case_path = case_root / "case.json"
            _write_json(case_path, case)
            output_dir = case_root / "out"
            command = [
                sys.executable,
                "-I",
                str(CASE_WORKER),
                "--services",
                str(SERVICES),
                "--case-json",
                str(case_path),
                "--seed",
                str(case["seed"]),
                "--controller",
                str(candidate_copy),
                "--controller-sha256",
                expected_sha256,
                "--experiment-id",
                str(experiment_id),
                "--out-dir",
                str(output_dir),
                "--plan-wall-sec",
                str(plan_wall_sec),
                "--plan-cpu-sec",
                str(plan_cpu_sec),
                "--plan-memory-mb",
                str(plan_memory_mb),
            ]
            if require_netns:
                command.append("--require-netns")
            if test_skip_netns:
                command.append("--test-audit-hook-only")
            environment = {
                "PATH": os.defpath,
                "HOME": str(case_root),
                "TMPDIR": str(case_root),
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONHASHSEED": "0",
                "OPENBLAS_NUM_THREADS": "1",
                "OMP_NUM_THREADS": "1",
                "MKL_NUM_THREADS": "1",
            }
            try:
                completed = subprocess.run(
                    command,
                    cwd=candidate_dir,
                    env=environment,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=case_wall_sec,
                    start_new_session=True,
                    preexec_fn=lambda: _worker_preexec(
                        case_memory_mb * 1024 * 1024,
                        max(1, math.ceil(case_wall_sec)),
                    ),
                )
            except subprocess.TimeoutExpired as exc:
                raise CaseInfrastructureError("case worker exceeded its wall limit") from exc
            except OSError as exc:
                raise CaseInfrastructureError(f"case worker could not start: {type(exc).__name__}") from exc
            if completed.returncode != 0:
                raise CaseInfrastructureError(
                    f"case worker failed with exit code {completed.returncode}"
                )
            result_path = output_dir / "result.json"
            trace_path = output_dir / "trace.json"
            metrics_path = output_dir / "metrics.json"
            if not result_path.is_file() or not trace_path.is_file() or not metrics_path.is_file():
                raise CaseInfrastructureError("case worker did not write all artifacts")
            result_bytes = result_path.read_bytes()
            try:
                result = SimRunResult.model_validate_json(result_bytes).model_dump(
                    mode="json", by_alias=True, exclude_none=True
                )
                trace = json.loads(trace_path.read_text(encoding="utf-8"))
                metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
            except (ValidationError, json.JSONDecodeError, OSError, TypeError) as exc:
                raise CaseInfrastructureError("case worker artifacts failed schema validation") from exc
            if result["controllerSha256"] != expected_sha256:
                raise CaseInfrastructureError("case worker returned a different controller SHA")
            if not isinstance(trace, dict) or not isinstance(trace.get("frames"), list):
                raise CaseInfrastructureError("case worker trace has an invalid shape")
            if not isinstance(metrics, dict):
                raise CaseInfrastructureError("case worker metrics have an invalid shape")
            case_artifacts.mkdir(parents=True, exist_ok=True)
            trace_out = case_artifacts / "trace.json"
            replay_out = case_artifacts / "replay.json"
            trace_out.write_bytes(trace_path.read_bytes())
            _write_json(replay_out, {"sampleHz": 10, "frames": trace["frames"]})
            trace_bytes = trace_out.read_bytes()
            replay_bytes = replay_out.read_bytes()
            case_wall_sec = time.perf_counter() - started
            metrics = {
                "simSteps": int(metrics.get("simSteps", 0)),
                "simTimeSec": float(metrics.get("simTimeSec", 0)),
                "physicsWallSec": float(metrics.get("physicsWallSec", 0)),
                "stepsPerSec": float(metrics.get("stepsPerSec", 0)),
                "planWallSec": float(metrics.get("planWallSec", 0)),
                "caseWallSec": case_wall_sec,
            }
            failure = result.get("firstFailure")
            return {
                "caseId": case_id,
                "suite": suite,
                "status": _case_status(result),
                "failureKinds": list(result["failureKinds"]),
                "firstFailure": failure,
                "completionTimeSec": result.get("completionTimeSec"),
                "experimentId": str(experiment_id),
                "tracePath": trace_out.relative_to(artifacts_dir).as_posix(),
                "traceSha256": _sha256_bytes(trace_bytes),
                "replayPath": replay_out.relative_to(artifacts_dir).as_posix(),
                "replaySha256": _sha256_bytes(replay_bytes),
                "metrics": metrics,
            }
    except CaseInfrastructureError:
        raise
    except Exception as exc:
        raise CaseInfrastructureError("case execution failed") from exc


def _case_status(result: dict[str, Any]) -> str:
    failure_kinds = set(result.get("failureKinds", []))
    if result.get("completed") and not failure_kinds:
        return "passed"
    if failure_kinds.intersection(INVALID_FAILURES):
        return "invalid"
    return "failed"


def _arguments() -> argparse.Namespace:
    def sha_argument(value: str) -> str:
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise argparse.ArgumentTypeError("expected a lowercase 64-character SHA-256")
        return value

    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--controller", type=Path)
    source.add_argument("--bundle", type=Path)
    parser.add_argument("--expected-sha256", required=True, type=sha_argument)
    parser.add_argument("--expected-bundle-sha256", type=sha_argument)
    parser.add_argument("--suite", required=True, choices=("public", "withheld", "all"))
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--manifest-out", type=Path)
    parser.add_argument("--withheld-manifest", type=Path, default=os.environ.get("FORKSAFE_WITHHELD_MANIFEST"))
    parser.add_argument("--consume-withheld-manifest", action="store_true")
    parser.add_argument("--candidate-id", type=UUID)
    parser.add_argument("--investigation-id", type=UUID)
    parser.add_argument("--evaluator-attempt-id", type=UUID)
    parser.add_argument("--artifacts-dir", type=Path)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--case-ids")
    parser.add_argument("--plan-wall-sec", type=float, default=10)
    parser.add_argument("--plan-cpu-sec", type=int, default=10)
    parser.add_argument("--plan-memory-mb", type=int, default=1024)
    parser.add_argument("--case-wall-sec", type=float, default=180)
    parser.add_argument("--case-memory-mb", type=int, default=3072)
    parser.add_argument("--test-audit-hook-only", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def _atomic_write(path: Path, document: dict[str, Any]) -> None:
    _atomic_json_write(path, document)


def _atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(finite_json(value), sort_keys=True, indent=2, allow_nan=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _base_document(args: argparse.Namespace) -> dict[str, Any]:
    sha = args.expected_sha256
    candidate_id = args.candidate_id or uuid5(NAMESPACE_URL, f"candidate:{sha}")
    investigation_id = args.investigation_id or uuid5(NAMESPACE_URL, f"investigation:{sha}")
    return {
        "schema": "forksafe.run_candidate.v1",
        "status": "infrastructure_error",
        "exitCode": 4,
        "controllerSha256": sha,
        "assetsSha256": None,
        "simulatorSha256": None,
        "bundleSha256": None,
        "engineVersion": mujoco.__version__,
        "evaluatorCodeSha256": None,
        "manifestSha256": {},
        "candidateId": str(candidate_id),
        "investigationId": str(investigation_id),
        "evaluatorAttemptId": str(args.evaluator_attempt_id or uuid4()),
        "idsDerived": args.candidate_id is None or args.investigation_id is None,
        "isolation": {
            "planProcess": "separate_process",
            "network": "audit_hook_only",
            "privilegeDrop": False,
            "auditHook": True,
            "parentDumpable": True,
        },
        "evaluations": [],
        "cases": [],
        "firstFailure": None,
        "metrics": {
            "casesTotal": 0,
            "casesPassed": 0,
            "casesFailed": 0,
            "casesInvalid": 0,
            "wallTimeSec": 0.0,
        },
        "error": None,
        "signing": {"mode": "unsigned", "keyId": None},
        "signedManifest": None,
    }


def _error_document(
    document: dict[str, Any],
    code: int,
    error_code: str,
    message: str,
) -> tuple[int, dict[str, Any]]:
    document["exitCode"] = code
    document["status"] = "integrity_error" if code == 3 else "infrastructure_error"
    document["error"] = {"code": error_code, "message": message}
    return code, document


def _candidate_evaluations(
    cases: list[dict[str, Any]],
    candidate_id: UUID,
    investigation_id: UUID,
    attempt_id: UUID,
) -> list[dict[str, Any]]:
    evaluations: list[dict[str, Any]] = []
    for suite in ("public", "withheld"):
        suite_cases = [case for case in cases if case["suite"] == suite]
        if not suite_cases:
            continue
        statuses = [case["status"] for case in suite_cases]
        all_passed = all(status == "passed" for status in statuses)
        status = (
            "passed"
            if all_passed
            else "invalid"
            if "invalid" in statuses
            else "failed"
        )
        completion_times = [
            case["completionTimeSec"]
            for case in suite_cases
            if case["status"] == "passed" and case.get("completionTimeSec") is not None
        ]
        evaluation = CandidateEvaluation(
            id=uuid4(),
            candidateId=candidate_id,
            investigationId=investigation_id,
            evaluatorAttemptId=attempt_id,
            suite=suite,
            cases=[
                CaseEvaluation(
                    caseId=case["caseId"],
                    status=case["status"],
                    experimentId=UUID(case["experimentId"]),
                    completionTimeSec=case.get("completionTimeSec"),
                    failureKinds=case["failureKinds"],
                )
                for case in suite_cases
            ],
            allRequiredPassed=all_passed,
            medianCompletionTimeSec=statistics.median(completion_times) if completion_times else None,
            status=status,
            createdAtMs=int(time.time() * 1000),
        )
        evaluations.append(
            evaluation.model_dump(mode="json", by_alias=True, exclude_none=True)
        )
    return evaluations


def run(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    key: SigningKey | None = None
    key_error: SigningKeyError | None = None
    try:
        key = load_signing_key()
    except SigningKeyError as exc:
        key_error = exc
    document = _base_document(args)
    wall_started = time.perf_counter()
    if key_error is not None:
        code, document = _error_document(document, 4, "signing_key_invalid", str(key_error))
        return code, document
    if os.environ.get("FORKSAFE_REQUIRE_SIGNING") == "1" and key is None:
        code, document = _error_document(
            document, 4, "signing_key_required", "a signing key is required"
        )
        return code, document
    if key is not None:
        if not _make_parent_nondumpable():
            code, document = _error_document(
                document, 4, "signing_isolation_failed", "could not disable parent dumpability"
            )
            return code, document
        document["signing"] = {"mode": "signed", "keyId": key.key_id}
    parent_dumpable = _parent_dumpable()
    document["isolation"]["parentDumpable"] = parent_dumpable
    try:
        assets_sha = verify_assets()
        document["assetsSha256"] = assets_sha
        lock = _manifest_lock()
        selected_suites = ("public", "withheld") if args.suite == "all" else (args.suite,)
        manifests: dict[str, dict[str, Any]] = {}
        for suite in selected_suites:
            if suite == "public":
                manifest_path = PUBLIC_MANIFEST
            else:
                if args.withheld_manifest is None:
                    raise CandidateIntegrityError("withheld manifest is required for this suite")
                manifest_path = Path(args.withheld_manifest)
            manifest, manifest_sha = _read_manifest(manifest_path, suite, lock[suite])
            manifests[suite] = manifest
            document["manifestSha256"][suite] = manifest_sha
            if suite == "withheld" and args.consume_withheld_manifest:
                try:
                    manifest_path.unlink()
                except OSError as exc:
                    raise CandidateIntegrityError("withheld manifest could not be consumed") from exc

        candidate_path = args.bundle if args.bundle is not None else args.controller
        assert candidate_path is not None
        bundle = admit(candidate_path)
        if bundle.controller_sha256 != args.expected_sha256:
            raise CandidateIntegrityError("controller SHA does not match --expected-sha256")
        if (
            args.expected_bundle_sha256 is not None
            and bundle.bundle_sha256 != args.expected_bundle_sha256
        ):
            raise CandidateIntegrityError("bundle SHA does not match --expected-bundle-sha256")
        document["controllerSha256"] = bundle.controller_sha256
        document["bundleSha256"] = bundle.bundle_sha256

        code_sha = code_tree_sha256()
        simulator_sha = simulator_tree_sha256()
        document["evaluatorCodeSha256"] = code_sha
        document["simulatorSha256"] = simulator_sha
        isolation = probe_isolation()
        require_netns = isolation["netns"] and not args.test_audit_hook_only
        document["isolation"].update(
            network="user_netns" if require_netns else "audit_hook_only",
            privilegeDrop=isolation["privilegeDrop"],
        )
        if os.environ.get("FORKSAFE_REQUIRE_NETNS") == "1" and not require_netns:
            return _error_document(
                document,
                4,
                "network_namespace_unavailable",
                "network namespace required but unavailable",
            )

        attempt_id = UUID(document["evaluatorAttemptId"])
        candidate_id = UUID(document["candidateId"])
        investigation_id = UUID(document["investigationId"])
        artifacts_dir = args.artifacts_dir or (
            args.out.parent / f"{args.out.stem}.artifacts"
        )
        work_dir = args.work_dir or Path(tempfile.gettempdir())
        case_ids = (
            {item.strip() for item in args.case_ids.split(",") if item.strip()}
            if args.case_ids
            else None
        )
        for suite in selected_suites:
            for payload in manifests[suite]["cases"]:
                case = SimCase.model_validate(payload).model_dump(by_alias=True, exclude_none=True)
                case_id = case["caseId"]
                if case_ids is not None and case_id not in case_ids:
                    continue
                if code_tree_sha256() != code_sha or simulator_tree_sha256() != simulator_sha:
                    raise CandidateIntegrityError("evaluator_code_modified")
                report = execute_case(
                    candidate_path,
                    args.expected_sha256,
                    case,
                    suite,
                    attempt_id,
                    candidate_id,
                    investigation_id,
                    artifacts_dir,
                    work_dir=work_dir,
                    plan_wall_sec=args.plan_wall_sec,
                    plan_cpu_sec=args.plan_cpu_sec,
                    plan_memory_mb=args.plan_memory_mb,
                    case_wall_sec=args.case_wall_sec,
                    case_memory_mb=args.case_memory_mb,
                    require_netns=require_netns,
                    test_skip_netns=args.test_audit_hook_only,
                    bundle=bundle,
                )
                if suite == "withheld" and report["firstFailure"] is not None:
                    report["firstFailure"] = dict(
                        report["firstFailure"], detail="redacted: withheld case"
                    )
                document["cases"].append(report)
        if code_tree_sha256() != code_sha or simulator_tree_sha256() != simulator_sha:
            raise CandidateIntegrityError("evaluator_code_modified")

        statuses = [case["status"] for case in document["cases"]]
        if "invalid" in statuses:
            result_status = "invalid"
        elif "failed" in statuses:
            result_status = "failed"
        else:
            result_status = "passed"
        for case in document["cases"]:
            if case["status"] != "passed":
                first_failure = case.get("firstFailure") or {}
                detail = (
                    "redacted: withheld case"
                    if case["suite"] == "withheld"
                    else first_failure.get("detail")
                )
                document["firstFailure"] = {
                    "caseId": case["caseId"],
                    "suite": case["suite"],
                    "kind": first_failure.get("kind")
                    or (case["failureKinds"][0] if case["failureKinds"] else "invalid_run"),
                    "tSec": first_failure.get("tSec", 0),
                    "detail": detail or "candidate did not pass",
                }
                break
        document["evaluations"] = _candidate_evaluations(
            document["cases"], candidate_id, investigation_id, attempt_id
        )
        document["status"] = result_status
        document["exitCode"] = 0 if result_status == "passed" else 1
        document["metrics"] = {
            "casesTotal": len(document["cases"]),
            "casesPassed": sum(case["status"] == "passed" for case in document["cases"]),
            "casesFailed": sum(case["status"] == "failed" for case in document["cases"]),
            "casesInvalid": sum(case["status"] == "invalid" for case in document["cases"]),
            "wallTimeSec": time.perf_counter() - wall_started,
        }
        if key is not None and document["exitCode"] in {0, 1}:
            try:
                manifests_lock_sha256 = _sha256_bytes(LOCK_PATH.read_bytes())
                filtered_cases = (
                    sorted(item.strip() for item in args.case_ids.split(",") if item.strip())
                    if args.case_ids
                    else None
                )
                payload = build_payload(
                    document,
                    bundle=bundle,
                    simulator_sha256=simulator_sha,
                    manifests_lock_sha256=manifests_lock_sha256,
                    case_filter=filtered_cases,
                    key_id=key.key_id,
                )
                envelope = sign_payload(payload, key)
                manifest_path = args.manifest_out or args.out.with_name(
                    f"{args.out.stem}.manifest.json"
                )
                _atomic_json_write(manifest_path, envelope)
                document["signedManifest"] = envelope
            except Exception as exc:  # noqa: BLE001
                document["signing"] = {"mode": "signed", "keyId": key.key_id}
                code, document = _error_document(
                    document, 4, "signing_failed", f"could not sign evaluation manifest ({type(exc).__name__})"
                )
                document["metrics"]["wallTimeSec"] = time.perf_counter() - wall_started
                return code, document
        return document["exitCode"], document
    except AdmissionError as exc:
        code, document = _error_document(
            document,
            3,
            "admission_rejected",
            f"{exc.reason}: {str(exc)[:120]}",
        )
        document["error"]["reason"] = exc.reason
        document["metrics"]["wallTimeSec"] = time.perf_counter() - wall_started
        return code, document
    except CandidateIntegrityError as exc:
        code, document = _error_document(document, 3, "integrity_error", str(exc))
        document["metrics"]["wallTimeSec"] = time.perf_counter() - wall_started
        return code, document
    except CaseInfrastructureError as exc:
        code, document = _error_document(document, 4, "case_infrastructure_error", str(exc))
        document["metrics"]["wallTimeSec"] = time.perf_counter() - wall_started
        return code, document
    except Exception as exc:  # noqa: BLE001
        code, document = _error_document(
            document, 4, "unexpected_error", f"unexpected {type(exc).__name__}"
        )
        document["metrics"]["wallTimeSec"] = time.perf_counter() - wall_started
        return code, document


def main() -> int:
    args = _arguments()
    if args.plan_wall_sec <= 0 or args.plan_cpu_sec <= 0 or args.plan_memory_mb <= 0:
        raise SystemExit(2)
    if args.case_wall_sec <= 0 or args.case_memory_mb <= 0:
        raise SystemExit(2)
    if args.consume_withheld_manifest and args.suite == "public":
        raise SystemExit(2)
    code, document = run(args)
    try:
        _atomic_write(args.out, document)
    except OSError:
        return 4
    if code == 3:
        return 3
    if code == 4:
        return 4
    return code


if __name__ == "__main__":
    raise SystemExit(main())
