from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class EvaluationModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class CaseEvaluation(EvaluationModel):
    case_id: str = Field(alias="caseId")
    status: Literal["queued", "running", "passed", "failed", "invalid"]
    experiment_id: UUID | None = Field(default=None, alias="experimentId")
    completion_time_sec: float | None = Field(default=None, ge=0, alias="completionTimeSec")
    failure_kinds: list[str] = Field(default_factory=list, alias="failureKinds")


class CandidateEvaluation(EvaluationModel):
    id: UUID
    candidate_id: UUID = Field(alias="candidateId")
    investigation_id: UUID = Field(alias="investigationId")
    evaluator_attempt_id: UUID = Field(alias="evaluatorAttemptId")
    suite: Literal["public", "withheld"]
    cases: list[CaseEvaluation]
    all_required_passed: bool = Field(alias="allRequiredPassed")
    median_completion_time_sec: float | None = Field(
        default=None,
        ge=0,
        alias="medianCompletionTimeSec",
    )
    status: Literal["queued", "running", "passed", "failed", "invalid"]
    report_artifact_id: UUID | None = Field(default=None, alias="reportArtifactId")
    created_at_ms: int = Field(ge=0, alias="createdAtMs")
