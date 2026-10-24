from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID, uuid4

import evaluator.app as evaluator_module
import pytest
from evaluator.app import (
    IDENTITY,
    CandidateRecord,
    EvaluatorState,
    _evaluate_with_telemetry,
    _run_case,
    _verify_manifests,
    app,
    changed_functions,
)
from evaluator.grader import rank
from evaluator.telemetry import init_telemetry, safe_attributes
from fastapi.testclient import TestClient
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


def _configure_store(monkeypatch, tmp_path):
    monkeypatch.setenv("EVALUATOR_STORE", str(tmp_path / "candidates"))
    monkeypatch.setenv("EVALUATOR_WORK_ROOT", str(tmp_path / "work"))
    monkeypatch.setenv("EVALUATOR_SERVICE_TOKEN", "unit-test-token")


def _candidate(source: str = "def plan(scene):\n    return []\n") -> dict[str, str]:
    return {
        "candidateId": str(uuid4()),
        "investigationId": str(uuid4()),
        "environmentId": str(uuid4()),
        "source": source,
    }


def test_health_and_authentication(monkeypatch, tmp_path):
    _configure_store(monkeypatch, tmp_path)
    with TestClient(app) as client:
        assert client.get("/health").json()["detail"] == IDENTITY
        payload = _candidate()
        monkeypatch.delenv("EVALUATOR_SERVICE_TOKEN")
        assert client.post("/candidates", json=payload).status_code == 503
        monkeypatch.setenv("EVALUATOR_SERVICE_TOKEN", "unit-test-token")
        assert client.post(
            "/candidates",
            json=payload,
            headers={"Authorization": "Bearer wrong"},
        ).status_code == 401


def test_unlisted_and_unfrozen_candidates_are_rejected(monkeypatch, tmp_path):
    _configure_store(monkeypatch, tmp_path)
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer unit-test-token"}
        unknown = {
            "candidateId": str(uuid4()),
            "investigationId": str(uuid4()),
            "controllerSha256": "0" * 64,
            "suite": "public",
        }
        assert client.post("/evaluations", json=unknown, headers=headers).status_code == 403
        registration = _candidate()
        response = client.post("/candidates", json=registration, headers=headers)
        assert response.status_code == 200
        assert response.json()["identity"] == IDENTITY
        duplicate = dict(registration, candidateId=str(uuid4()))
        duplicate_response = client.post("/candidates", json=duplicate, headers=headers)
        assert duplicate_response.status_code == 200
        assert duplicate_response.json()["controllerSha256"] == response.json()["controllerSha256"]
        assert duplicate_response.json()["deduplicated"]
        request_body = {
            "candidateId": registration["candidateId"],
            "investigationId": registration["investigationId"],
            "controllerSha256": response.json()["controllerSha256"],
            "suite": "withheld",
        }
        assert client.post("/evaluations", json=request_body, headers=headers).status_code == 403


def test_changed_stored_bytes_return_conflict(monkeypatch, tmp_path):
    _configure_store(monkeypatch, tmp_path)
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer unit-test-token"}
        registration = _candidate()
        response = client.post("/candidates", json=registration, headers=headers)
        assert response.status_code == 200
        record = app.state.evaluator.candidates[UUID(registration["candidateId"])]
        record.source_path.write_text("def plan(scene):\n    return [{'skill': 'open_gripper'}]\n")
        request_body = {
            "candidateId": registration["candidateId"],
            "investigationId": registration["investigationId"],
            "controllerSha256": response.json()["controllerSha256"],
            "suite": "public",
        }
        assert client.post("/evaluations", json=request_body, headers=headers).status_code == 409


def test_candidate_subprocess_does_not_inherit_service_secrets(monkeypatch, tmp_path):
    _configure_store(monkeypatch, tmp_path)
    monkeypatch.setenv("UNRELATED_SECRET", "do-not-forward")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=not-forwarded")
    source_path = tmp_path / "source" / "task_controller.py"
    source_path.parent.mkdir()
    source_path.write_text("def plan(scene):\n    return []\n")
    controller_sha = evaluator_module.hashlib.sha256(source_path.read_bytes()).hexdigest()
    candidate = CandidateRecord(
        candidate_id=uuid4(),
        investigation_id=uuid4(),
        environment_id=uuid4(),
        controller_sha256=controller_sha,
        changed_functions=[],
        source_path=source_path,
    )
    state = EvaluatorState()
    captured = {}

    def fake_run(command, cwd, env, **kwargs):
        captured.update(cwd=cwd, env=env)
        output_dir = Path(command[command.index("--out-dir") + 1])
        output_dir.mkdir()
        (output_dir / "result.json").write_text(
            json.dumps(
                {
                    "completed": False,
                    "failureKinds": ["invalid_run"],
                    "controllerSha256": controller_sha,
                }
            )
        )
        (output_dir / "trace.json").write_text("{}")

    monkeypatch.setattr(evaluator_module.subprocess, "run", fake_run)
    outcome = _run_case(
        state,
        candidate,
        {"caseId": "secret-check", "suite": "public", "seed": 0, "sceneOverrides": {}},
    )
    assert outcome["status"] == "invalid"
    assert captured["cwd"].is_relative_to(state.work_root)
    assert "EVALUATOR_SERVICE_TOKEN" not in captured["env"]
    assert "UNRELATED_SECRET" not in captured["env"]
    assert not any(key.startswith("OTEL_") for key in captured["env"])


def test_evaluator_telemetry_is_disabled_without_an_endpoint():
    exporter = InMemorySpanExporter()
    telemetry = init_telemetry(
        env={},
        span_exporter=exporter,
        metric_reader=InMemoryMetricReader(),
    )
    assert telemetry.enabled is False
    assert telemetry.extract_traceparent(
        "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
    ) is None
    with telemetry.span("evaluator.evaluate", {"forksafe.eval.suite": "public"}):
        pass
    telemetry.shutdown()
    assert exporter.get_finished_spans() == ()


def test_query_strings_are_removed_from_url_path_attributes():
    assert safe_attributes({
        "url.path": "/evaluations?private=query",
        "prompt": "not-allowed",
    }) == {"url.path": "/evaluations"}


def test_withheld_case_spans_use_indexes_and_traceparent(monkeypatch, tmp_path):
    exporter = InMemorySpanExporter()
    telemetry = init_telemetry(
        env={"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"},
        span_exporter=exporter,
        metric_reader=InMemoryMetricReader(),
    )
    state = EvaluatorState()
    state.telemetry = telemetry
    source_path = tmp_path / "task_controller.py"
    source_path.write_text("def plan(scene):\n    return []\n")
    candidate = CandidateRecord(
        candidate_id=uuid4(),
        investigation_id=uuid4(),
        environment_id=uuid4(),
        controller_sha256=evaluator_module.hashlib.sha256(source_path.read_bytes()).hexdigest(),
        changed_functions=[],
        source_path=source_path,
    )

    def fake_run_case(_state, _candidate, payload, _suite):
        return {
            "caseId": payload["caseId"],
            "status": "passed",
            "experimentId": str(uuid4()),
            "failureKinds": [],
        }

    monkeypatch.setattr(evaluator_module, "_run_case", fake_run_case)
    parent = telemetry.extract_traceparent(
        "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
    )
    with telemetry.span("evaluator.admission", {
        "forksafe.eval.candidate_id": str(candidate.candidate_id),
        "forksafe.eval.suite": "withheld",
    }, parent):
        _evaluate_with_telemetry(state, candidate, "withheld")
    telemetry.shutdown()

    spans = exporter.get_finished_spans()
    admission = next(span for span in spans if span.name == "evaluator.admission")
    evaluation = next(span for span in spans if span.name == "evaluator.evaluate")
    case_spans = [span for span in spans if span.name == "evaluator.case"]
    assert admission.parent.span_id == int("0123456789abcdef", 16)
    assert evaluation.parent.span_id == admission.context.span_id
    assert case_spans
    assert all("forksafe.eval.case_id" not in span.attributes for span in case_spans)
    assert sorted(span.attributes["forksafe.eval.case_index"] for span in case_spans) == list(range(len(case_spans)))
    assert all(span.attributes["forksafe.eval.suite"] == "withheld" for span in case_spans)


def test_finalize_freezes_ranked_finalists_and_runs_withheld_once(monkeypatch, tmp_path):
    _configure_store(monkeypatch, tmp_path)
    evaluations = []

    def evaluate(state, candidate, suite):
        evaluations.append((candidate.candidate_id, suite))
        return {
            "id": str(uuid4()),
            "candidateId": str(candidate.candidate_id),
            "investigationId": str(candidate.investigation_id),
            "evaluatorAttemptId": str(uuid4()),
            "suite": suite,
            "cases": [
                {
                    "caseId": f"{suite}-case",
                    "status": "passed",
                    "experimentId": str(uuid4()),
                    "completionTimeSec": 5.0,
                    "failureKinds": [],
                }
            ],
            "allRequiredPassed": True,
            "medianCompletionTimeSec": 5.0,
            "status": "passed",
            "createdAtMs": 1,
        }

    monkeypatch.setattr(evaluator_module, "_evaluate", evaluate)
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer unit-test-token"}
        investigation_id = uuid4()
        same_environment = uuid4()
        other_environment = uuid4()
        registrations = [
            {
                "candidateId": str(uuid4()),
                "investigationId": str(investigation_id),
                "environmentId": str(same_environment),
                "source": f"VALUE = {index}\ndef plan(scene):\n    return []\n",
            }
            for index in range(3)
        ]
        registrations.append(
            {
                "candidateId": str(uuid4()),
                "investigationId": str(investigation_id),
                "environmentId": str(other_environment),
                "source": "VALUE = 4\ndef plan(scene):\n    return []\n",
            }
        )
        for registration in registrations:
            response = client.post("/candidates", json=registration, headers=headers)
            assert response.status_code == 200

        payload = {
            "investigationId": str(investigation_id),
            "candidateIds": [registration["candidateId"] for registration in registrations],
        }
        first = client.post("/finalize", json=payload, headers=headers)
        assert first.status_code == 200
        assert len(first.json()["finalistIds"]) == 3
        assert len(first.json()["withheldEvaluations"]) == 3
        selected = [
            app.state.evaluator.candidates[UUID(candidate_id)]
            for candidate_id in first.json()["finalistIds"]
        ]
        assert sum(candidate.environment_id == same_environment for candidate in selected) == 2
        assert sum(candidate.environment_id == other_environment for candidate in selected) == 1

        second = client.post("/finalize", json=payload, headers=headers)
        assert second.status_code == 200
        assert len(evaluations) == 7


def test_grader_ranks_eligible_candidates_and_tie_breaks():
    entries = [
        {
            "candidateId": "b",
            "changedFunctions": ["plan"],
            "allRequiredPassed": True,
            "medianCompletionTimeSec": 4.0,
        },
        {
            "candidateId": "c",
            "changedFunctions": ["plan", "carry"],
            "allRequiredPassed": True,
            "medianCompletionTimeSec": 3.0,
        },
        {
            "candidateId": "a",
            "changedFunctions": ["plan"],
            "allRequiredPassed": True,
            "medianCompletionTimeSec": 4.0,
        },
        {
            "candidateId": "d",
            "changedFunctions": [],
            "allRequiredPassed": False,
            "medianCompletionTimeSec": 1.0,
        },
    ]
    ranked = rank(entries)
    assert [entry["candidateId"] for entry in ranked] == ["a", "b", "c", "d"]
    assert ranked[-1]["eligible"] is False
    assert ranked[-1]["reasons"]


def test_changed_functions_reports_additions_and_module_changes():
    baseline = "VALUE = 1\n\ndef plan(scene):\n    return []\n"
    candidate = "VALUE = 2\n\ndef plan(scene):\n    return []\n\ndef helper():\n    return 1\n"
    assert changed_functions(baseline, candidate) == ["<module>", "helper"]


def test_manifest_lock_mismatch_blocks_evaluator_startup(monkeypatch):
    monkeypatch.setattr(evaluator_module, "_sha256", lambda path: "0" * 64)
    with pytest.raises(RuntimeError, match="manifest hash"):
        _verify_manifests()
