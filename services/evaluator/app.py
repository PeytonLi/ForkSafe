from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from simulator.assets import verify_assets
from simulator.models import SimCase

from evaluator.grader import rank
from evaluator.models import CandidateEvaluation

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = "forksafe-evaluator"
INVALID_FAILURES = {"invalid_run", "engine_error", "missing_artifact"}
_DIFF_SPEC = importlib.util.spec_from_file_location(
    "forksafe_changed_functions",
    ROOT / "controllers/diff.py",
)
if _DIFF_SPEC is None or _DIFF_SPEC.loader is None:
    raise RuntimeError("controllers/diff.py is unavailable")
_DIFF_MODULE = importlib.util.module_from_spec(_DIFF_SPEC)
_DIFF_SPEC.loader.exec_module(_DIFF_MODULE)
changed_functions = _DIFF_MODULE.changed_functions


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class CandidateRegistrationRequest(ApiModel):
    candidate_id: UUID = Field(alias="candidateId")
    investigation_id: UUID = Field(alias="investigationId")
    environment_id: UUID = Field(alias="environmentId")
    source: str = Field(max_length=200_000)


class EvaluationRequest(ApiModel):
    candidate_id: UUID = Field(alias="candidateId")
    controller_sha256: str = Field(alias="controllerSha256", min_length=64, max_length=64)
    suite: Literal["public", "withheld"]
    investigation_id: UUID = Field(alias="investigationId")


class FinalizeRequest(ApiModel):
    investigation_id: UUID = Field(alias="investigationId")
    candidate_ids: list[UUID] = Field(alias="candidateIds", min_length=1)


@dataclass
class CandidateRecord:
    candidate_id: UUID
    investigation_id: UUID
    environment_id: UUID
    controller_sha256: str
    changed_functions: list[str]
    source_path: Path


class EvaluatorState:
    def __init__(self) -> None:
        evaluator_root = Path(os.environ.get("EVALUATOR_STORE", ROOT / "var/evaluator/candidates"))
        self.store_root = evaluator_root.resolve()
        self.store_root.mkdir(parents=True, exist_ok=True)
        self.work_root = Path(
            os.environ.get("EVALUATOR_WORK_ROOT", self.store_root.parent / "work")
        ).resolve()
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.candidates: dict[UUID, CandidateRecord] = {}
        self.public_evaluations: dict[UUID, dict[str, Any]] = {}
        self.withheld_evaluations: dict[UUID, dict[str, Any]] = {}
        self.frozen_finalists: dict[UUID, set[UUID]] = {}
        self.withheld_completed: set[tuple[UUID, UUID]] = set()
        self.finalization_path = self.store_root.parent / "finalizations.json"
        self._load_candidates()
        self._load_evaluations()
        self._load_finalizations()

    def _load_candidates(self) -> None:
        for metadata_path in self.store_root.glob("*/registrations.json"):
            source_path = metadata_path.parent / "task_controller.py"
            try:
                registrations = json.loads(metadata_path.read_text())
                for registration in registrations:
                    candidate = CandidateRecord(
                        candidate_id=UUID(registration["candidateId"]),
                        investigation_id=UUID(registration["investigationId"]),
                        environment_id=UUID(registration["environmentId"]),
                        controller_sha256=registration["controllerSha256"],
                        changed_functions=registration["changedFunctions"],
                        source_path=source_path,
                    )
                    self.candidates[candidate.candidate_id] = candidate
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                continue

    def _load_finalizations(self) -> None:
        if not self.finalization_path.is_file():
            return
        try:
            payload = json.loads(self.finalization_path.read_text())
            self.frozen_finalists = {
                UUID(investigation_id): {UUID(candidate_id) for candidate_id in candidate_ids}
                for investigation_id, candidate_ids in payload.get("frozenFinalists", {}).items()
            }
            self.withheld_completed = {
                (UUID(item["investigationId"]), UUID(item["candidateId"]))
                for item in payload.get("withheldCompleted", [])
            }
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            self.frozen_finalists = {}
            self.withheld_completed = set()

    def _load_evaluations(self) -> None:
        for evaluation_path in self.store_root.glob("*/evaluations/*.json"):
            try:
                evaluation = json.loads(evaluation_path.read_text())
                candidate_id = UUID(evaluation["candidateId"])
                if evaluation["suite"] == "public":
                    self.public_evaluations[candidate_id] = evaluation
                elif evaluation["suite"] == "withheld":
                    self.withheld_evaluations[candidate_id] = evaluation
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                continue

    def save_evaluation(self, candidate: CandidateRecord, evaluation: dict[str, Any]) -> None:
        evaluation_dir = candidate.source_path.parent / "evaluations"
        evaluation_dir.mkdir(parents=True, exist_ok=True)
        path = evaluation_dir / f"{candidate.candidate_id}-{evaluation['suite']}.json"
        path.write_text(json.dumps(evaluation, indent=2) + "\n")

    def _save_finalizations(self) -> None:
        payload = {
            "frozenFinalists": {
                str(investigation_id): sorted(str(candidate_id) for candidate_id in candidate_ids)
                for investigation_id, candidate_ids in self.frozen_finalists.items()
            },
            "withheldCompleted": [
                {"investigationId": str(investigation_id), "candidateId": str(candidate_id)}
                for investigation_id, candidate_id in sorted(
                    self.withheld_completed, key=lambda pair: (str(pair[0]), str(pair[1]))
                )
            ],
        }
        self.finalization_path.write_text(json.dumps(payload, indent=2) + "\n")

    def register(self, request: CandidateRegistrationRequest) -> tuple[CandidateRecord, bool]:
        source_bytes = request.source.encode("utf-8")
        controller_sha = hashlib.sha256(source_bytes).hexdigest()
        existing = self.candidates.get(request.candidate_id)
        if existing:
            if (
                existing.controller_sha256 != controller_sha
                or existing.investigation_id != request.investigation_id
                or existing.environment_id != request.environment_id
            ):
                raise HTTPException(status_code=409, detail="candidateId is already registered differently")
            return existing, True

        source_dir = self.store_root / controller_sha
        source_path = source_dir / "task_controller.py"
        deduplicated = source_path.is_file()
        source_dir.mkdir(parents=True, exist_ok=True)
        if not deduplicated:
            source_path.write_bytes(source_bytes)
        baseline = (ROOT / "controllers/baseline/task_controller.py").read_text()
        record = CandidateRecord(
            candidate_id=request.candidate_id,
            investigation_id=request.investigation_id,
            environment_id=request.environment_id,
            controller_sha256=controller_sha,
            changed_functions=changed_functions(baseline, request.source),
            source_path=source_path,
        )
        metadata_path = source_dir / "registrations.json"
        registrations = json.loads(metadata_path.read_text()) if metadata_path.is_file() else []
        registrations.append(
            {
                "candidateId": str(record.candidate_id),
                "investigationId": str(record.investigation_id),
                "environmentId": str(record.environment_id),
                "controllerSha256": record.controller_sha256,
                "changedFunctions": record.changed_functions,
            }
        )
        metadata_path.write_text(json.dumps(registrations, indent=2) + "\n")
        self.candidates[record.candidate_id] = record
        return record, deduplicated


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _verify_manifests() -> None:
    verify_assets()
    lock_path = ROOT / "evaluation/manifests.lock.json"
    lock = json.loads(lock_path.read_text())
    for suite in ("public", "withheld"):
        manifest_path = ROOT / f"evaluation/{suite}/manifest.json"
        if _sha256(manifest_path) != lock[suite]:
            raise RuntimeError(f"{suite} manifest hash does not match evaluation/manifests.lock.json")


def _authorize(authorization: str | None = Header(default=None)) -> None:
    token = os.environ.get("EVALUATOR_SERVICE_TOKEN")
    if not token:
        raise HTTPException(status_code=503, detail="blocked: EVALUATOR_SERVICE_TOKEN not configured")
    if authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="invalid evaluator authorization")


def _run_case(
    state: EvaluatorState,
    candidate: CandidateRecord,
    case_payload: dict[str, Any],
) -> dict[str, Any]:
    case_id = str(case_payload["caseId"])
    experiment_id = uuid4()
    try:
        source_bytes = candidate.source_path.read_bytes()
    except OSError:
        return {
            "caseId": case_id,
            "status": "invalid",
            "experimentId": str(experiment_id),
            "failureKinds": ["missing_artifact"],
        }
    if hashlib.sha256(source_bytes).hexdigest() != candidate.controller_sha256:
        raise HTTPException(status_code=409, detail="stored controller bytes do not match registered SHA")
    with tempfile.TemporaryDirectory(dir=state.work_root) as temporary:
        workspace = Path(temporary)
        controller_dir = workspace / "controller"
        controller_dir.mkdir()
        (controller_dir / "task_controller.py").write_bytes(source_bytes)
        case_path = workspace / "case.json"
        case_path.write_text(json.dumps(case_payload))
        output_dir = workspace / "artifacts"
        command = [
            sys.executable,
            "-m",
            "simulator.cli",
            "--controller-dir",
            str(controller_dir),
            "--case-json",
            str(case_path),
            "--seed",
            str(case_payload["seed"]),
            "--out-dir",
            str(output_dir),
            "--experiment-id",
            str(experiment_id),
            "--timeout-sec",
            "30",
        ]
        environment = {
            "HOME": str(workspace),
            "PATH": os.defpath,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(ROOT / "services"),
            "TMPDIR": str(workspace),
        }
        try:
            subprocess.run(
                command,
                cwd=workspace,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
                timeout=40,
            )
        except subprocess.TimeoutExpired:
            return {
                "caseId": case_id,
                "status": "invalid",
                "experimentId": str(experiment_id),
                "failureKinds": ["missing_artifact"],
            }
        result_path = output_dir / "result.json"
        trace_path = output_dir / "trace.json"
        if not result_path.is_file() or not trace_path.is_file():
            return {
                "caseId": case_id,
                "status": "invalid",
                "experimentId": str(experiment_id),
                "failureKinds": ["missing_artifact"],
            }
        result = json.loads(result_path.read_text())
    failure_kinds = list(result.get("failureKinds", []))
    if result.get("controllerSha256") != candidate.controller_sha256:
        return {
            "caseId": case_id,
            "status": "invalid",
            "experimentId": str(experiment_id),
            "failureKinds": ["invalid_run"],
        }
    if result.get("completed") and not failure_kinds:
        status = "passed"
    elif INVALID_FAILURES.intersection(failure_kinds):
        status = "invalid"
    else:
        status = "failed"
    item = {
        "caseId": case_id,
        "status": status,
        "experimentId": str(experiment_id),
        "failureKinds": failure_kinds,
    }
    if result.get("completionTimeSec") is not None:
        item["completionTimeSec"] = result["completionTimeSec"]
    return item


def _evaluate(
    state: EvaluatorState,
    candidate: CandidateRecord,
    suite: Literal["public", "withheld"],
) -> dict[str, Any]:
    manifest_path = ROOT / f"evaluation/{suite}/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    cases = [
        _run_case(state, candidate, SimCase.model_validate(case).model_dump(by_alias=True))
        for case in manifest["cases"]
    ]
    all_passed = bool(cases) and all(case["status"] == "passed" for case in cases)
    if all_passed:
        status = "passed"
    elif any(case["status"] == "invalid" for case in cases):
        status = "invalid"
    else:
        status = "failed"
    completion_times = [
        case["completionTimeSec"]
        for case in cases
        if case["status"] == "passed" and "completionTimeSec" in case
    ]
    evaluation = CandidateEvaluation(
        id=uuid4(),
        candidateId=str(candidate.candidate_id),
        investigationId=str(candidate.investigation_id),
        evaluatorAttemptId=str(uuid4()),
        suite=suite,
        cases=cases,
        allRequiredPassed=all_passed,
        medianCompletionTimeSec=statistics.median(completion_times) if completion_times else None,
        status=status,
        createdAtMs=int(time.time() * 1000),
    )
    return evaluation.model_dump(mode="json", by_alias=True, exclude_none=True)


def _public_entry(candidate: CandidateRecord, evaluation: dict[str, Any]) -> dict[str, Any]:
    return {
        "candidateId": str(candidate.candidate_id),
        "controllerSha256": candidate.controller_sha256,
        "environmentId": str(candidate.environment_id),
        "changedFunctions": candidate.changed_functions,
        "allRequiredPassed": evaluation["allRequiredPassed"],
        "medianCompletionTimeSec": evaluation.get("medianCompletionTimeSec"),
        "reasons": [] if evaluation["allRequiredPassed"] else [evaluation["status"]],
    }


def _max_finalists() -> int:
    config = json.loads((ROOT / "evaluation/grader.json").read_text())
    return int(config["maxFinalists"])


def _max_per_environment() -> int:
    config = json.loads((ROOT / "evaluation/grader.json").read_text())
    return int(config["maxCandidatesPerEnvironment"])


@asynccontextmanager
async def _lifespan(app: FastAPI):
    _verify_manifests()
    app.state.evaluator = EvaluatorState()
    yield


app = FastAPI(title="ForkSafe evaluator", lifespan=_lifespan)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "name": "evaluator",
        "mode": "local",
        "detail": IDENTITY,
        "checkedAtMs": time.time_ns() // 1_000_000,
    }


@app.post("/candidates", dependencies=[Depends(_authorize)])
def register_candidate(
    request_body: CandidateRegistrationRequest,
    request: Request,
) -> dict[str, object]:
    state: EvaluatorState = request.app.state.evaluator
    candidate, deduplicated = state.register(request_body)
    return {
        "identity": IDENTITY,
        "candidateId": str(candidate.candidate_id),
        "investigationId": str(candidate.investigation_id),
        "environmentId": str(candidate.environment_id),
        "controllerSha256": candidate.controller_sha256,
        "changedFunctions": candidate.changed_functions,
        "deduplicated": deduplicated,
    }


@app.post("/evaluations", dependencies=[Depends(_authorize)])
def evaluate_candidate(
    request_body: EvaluationRequest,
    request: Request,
) -> dict[str, Any]:
    state: EvaluatorState = request.app.state.evaluator
    candidate = state.candidates.get(request_body.candidate_id)
    if (
        candidate is None
        or candidate.controller_sha256 != request_body.controller_sha256
        or candidate.investigation_id != request_body.investigation_id
    ):
        raise HTTPException(status_code=403, detail="candidate or controller SHA is not registered")
    try:
        stored_sha = _sha256(candidate.source_path)
    except OSError as exc:
        raise HTTPException(status_code=409, detail="registered controller source is unavailable") from exc
    if stored_sha != request_body.controller_sha256:
        raise HTTPException(status_code=409, detail="stored controller bytes do not match requested SHA")
    if request_body.suite == "withheld":
        frozen = state.frozen_finalists.get(request_body.investigation_id, set())
        if candidate.candidate_id not in frozen:
            raise HTTPException(status_code=403, detail="withheld evaluation is reserved for frozen finalists")
        key = (request_body.investigation_id, candidate.candidate_id)
        existing = state.withheld_evaluations.get(candidate.candidate_id)
        if key in state.withheld_completed:
            if existing:
                return existing
            raise HTTPException(status_code=409, detail="withheld result is unavailable and cannot be rerun")
        evaluation = _evaluate(state, candidate, "withheld")
        state.withheld_evaluations[candidate.candidate_id] = evaluation
        state.withheld_completed.add(key)
        state.save_evaluation(candidate, evaluation)
        state._save_finalizations()
    else:
        evaluation = _evaluate(state, candidate, "public")
        state.public_evaluations[candidate.candidate_id] = evaluation
        state.save_evaluation(candidate, evaluation)
    return evaluation


@app.post("/finalize", dependencies=[Depends(_authorize)])
def finalize(
    request_body: FinalizeRequest,
    request: Request,
) -> dict[str, Any]:
    state: EvaluatorState = request.app.state.evaluator
    candidate_records = []
    candidate_ids = list(dict.fromkeys(request_body.candidate_ids))
    frozen = state.frozen_finalists.get(request_body.investigation_id)
    if frozen is not None:
        candidate_ids.extend(
            candidate_id
            for candidate_id in sorted(frozen, key=str)
            if candidate_id not in candidate_ids
        )
    for candidate_id in candidate_ids:
        candidate = state.candidates.get(candidate_id)
        if candidate is None or candidate.investigation_id != request_body.investigation_id:
            raise HTTPException(status_code=403, detail=f"candidate {candidate_id} is not registered")
        try:
            stored_sha = _sha256(candidate.source_path)
        except OSError as exc:
            raise HTTPException(status_code=409, detail=f"stored controller source is unavailable for {candidate_id}") from exc
        if stored_sha != candidate.controller_sha256:
            raise HTTPException(status_code=409, detail=f"stored controller bytes do not match SHA for {candidate_id}")
        candidate_records.append(candidate)
    public_results: dict[UUID, dict[str, Any]] = {}
    for candidate in candidate_records:
        evaluation = state.public_evaluations.get(candidate.candidate_id)
        if evaluation is None:
            evaluation = _evaluate(state, candidate, "public")
            state.public_evaluations[candidate.candidate_id] = evaluation
            state.save_evaluation(candidate, evaluation)
        public_results[candidate.candidate_id] = evaluation

    public_ranking = rank(
        [_public_entry(candidate, public_results[candidate.candidate_id]) for candidate in candidate_records]
    )
    if frozen is None:
        finalist_ids: list[UUID] = []
        seen_hashes: set[str] = set()
        environment_counts: dict[UUID, int] = {}
        for entry in public_ranking:
            if not entry["eligible"]:
                continue
            candidate_id = UUID(entry["candidateId"])
            candidate = state.candidates[candidate_id]
            if candidate.controller_sha256 in seen_hashes:
                continue
            count = environment_counts.get(candidate.environment_id, 0)
            if count >= _max_per_environment():
                continue
            seen_hashes.add(candidate.controller_sha256)
            environment_counts[candidate.environment_id] = count + 1
            finalist_ids.append(candidate_id)
            if len(finalist_ids) == _max_finalists():
                break
        state.frozen_finalists[request_body.investigation_id] = set(finalist_ids)
        state._save_finalizations()
    else:
        finalist_ids = [
            candidate.candidate_id
            for candidate in candidate_records
            if candidate.candidate_id in frozen
        ]

    withheld_results: dict[UUID, dict[str, Any]] = {}
    for candidate_id in finalist_ids:
        candidate = state.candidates[candidate_id]
        key = (request_body.investigation_id, candidate_id)
        evaluation = state.withheld_evaluations.get(candidate_id)
        if evaluation is None and key not in state.withheld_completed:
            evaluation = _evaluate(state, candidate, "withheld")
            state.withheld_evaluations[candidate_id] = evaluation
            state.withheld_completed.add(key)
            state.save_evaluation(candidate, evaluation)
            state._save_finalizations()
        if evaluation is not None:
            withheld_results[candidate_id] = evaluation

    final_entries = []
    for candidate in candidate_records:
        public = public_results[candidate.candidate_id]
        withheld = withheld_results.get(candidate.candidate_id)
        all_passed = public["allRequiredPassed"] and bool(withheld and withheld["allRequiredPassed"])
        passed_times = [
            case["completionTimeSec"]
            for evaluation in (public, withheld)
            if evaluation
            for case in evaluation["cases"]
            if case["status"] == "passed" and "completionTimeSec" in case
        ]
        reasons = []
        if not public["allRequiredPassed"]:
            reasons.append("public suite did not pass")
        elif not withheld:
            reasons.append("not selected as a finalist")
        elif not withheld["allRequiredPassed"]:
            reasons.append("withheld suite did not pass")
        final_entries.append(
            {
                "candidateId": str(candidate.candidate_id),
                "controllerSha256": candidate.controller_sha256,
                "environmentId": str(candidate.environment_id),
                "changedFunctions": candidate.changed_functions,
                "allRequiredPassed": all_passed,
                "medianCompletionTimeSec": statistics.median(passed_times) if passed_times else None,
                "reasons": reasons,
            }
        )
    return {
        "identity": IDENTITY,
        "investigationId": str(request_body.investigation_id),
        "finalistIds": [str(candidate_id) for candidate_id in finalist_ids],
        "publicEvaluations": [public_results[candidate.candidate_id] for candidate in candidate_records],
        "withheldEvaluations": [withheld_results[candidate_id] for candidate_id in finalist_ids if candidate_id in withheld_results],
        "ranking": rank(final_entries),
    }
