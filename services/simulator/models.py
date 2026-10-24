from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ContractModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="allow")


class SimCase(ContractModel):
    case_id: str = Field(min_length=1, alias="caseId")
    suite: Literal["original", "public", "withheld"]
    seed: int = Field(ge=0)
    scene_overrides: dict[str, float] = Field(default_factory=dict, alias="sceneOverrides")
    description: str | None = None


class SimRunRequest(ContractModel):
    experiment_id: UUID = Field(alias="experimentId")
    seed: int = Field(ge=0)
    controller_dir: str = Field(min_length=1, alias="controllerDir")
    case_id: str = Field(min_length=1, alias="caseId")
    timeout_sec: float = Field(default=30, gt=0, alias="timeoutSec")
    out_dir: str = Field(min_length=1, alias="outDir")


class SimFrame(ContractModel):
    t_sec: float = Field(ge=0, alias="tSec")
    qpos: list[float]
    qvel: list[float]
    ctrl: list[float]
    bodies: list[dict[str, Any]]
    contacts: list[dict[str, Any]]
    cube_pos: tuple[float, float, float] | None = Field(default=None, alias="cubePos")
    attached: bool = False


class FirstFailure(ContractModel):
    kind: str
    t_sec: float = Field(ge=0, alias="tSec")
    detail: str


class SimRunResult(ContractModel):
    experiment_id: UUID = Field(alias="experimentId")
    completed: bool
    completion_time_sec: float | None = Field(default=None, ge=0, alias="completionTimeSec")
    failure_kinds: list[str] = Field(default_factory=list, alias="failureKinds")
    first_failure: FirstFailure | None = Field(default=None, alias="firstFailure")
    frames: list[SimFrame] = Field(default_factory=list)
    engine_version: str = Field(min_length=1, alias="engineVersion")
    assets_sha256: str = Field(min_length=64, max_length=64, alias="assetsSha256")
    controller_sha256: str = Field(min_length=64, max_length=64, alias="controllerSha256")


class SceneConfiguration(ContractModel):
    cube_start: tuple[float, float, float] = Field(alias="cubeStart")
    target: tuple[float, float, float]
    divider_center: tuple[float, float] = Field(alias="dividerCenter")
    divider_half_length: float = Field(alias="dividerHalfLength")
    divider_half_thickness: float = Field(alias="dividerHalfThickness")
    divider_height: float = Field(alias="dividerHeight")


class CandidateRegistration(ContractModel):
    candidate_id: UUID = Field(alias="candidateId")
    investigation_id: UUID = Field(alias="investigationId")
    environment_id: UUID = Field(alias="environmentId")
    source: str


class EvaluationRequest(ContractModel):
    candidate_id: UUID = Field(alias="candidateId")
    controller_sha256: str = Field(alias="controllerSha256")
    suite: str
    investigation_id: UUID = Field(alias="investigationId")


class FinalizeRequest(ContractModel):
    investigation_id: UUID = Field(alias="investigationId")
    candidate_ids: list[UUID] = Field(alias="candidateIds")
