import { isUuid } from "./ids.js";
import type { GrantLike, LogicResult } from "./types.js";

export interface FindingUseInput {
  id: string;
  findingId: string;
  experimentId?: string;
  candidateId?: string;
  grantId: string;
  attemptId: string;
  epoch: number;
}

interface FindingUseTarget {
  investigationId: string;
  environmentId?: string;
}

export function findingUseKey(input: Pick<FindingUseInput, "findingId" | "experimentId" | "candidateId">): string {
  return input.experimentId !== undefined
    ? `${input.findingId}:experiment:${input.experimentId}`
    : `${input.findingId}:candidate:${input.candidateId}`;
}

export function planFindingUse(input: {
  grant: GrantLike;
  finding?: FindingUseTarget;
  findingTombstoned: boolean;
  experiment?: FindingUseTarget;
  candidate?: FindingUseTarget;
  existingSameId?: { identical: boolean };
  existingSameKey?: boolean;
  input: FindingUseInput;
}): LogicResult<{ noOp: boolean; crossEnvironment: boolean }> {
  const value = input.input;
  const hasExperiment = value.experimentId !== undefined;
  const hasCandidate = value.candidateId !== undefined;
  if (hasExperiment === hasCandidate) {
    return { ok: false, code: "invalid_finding_use", message: "Exactly one experiment or candidate is required" };
  }
  if (
    !isUuid(value.id) ||
    !isUuid(value.findingId) ||
    (value.experimentId !== undefined && !isUuid(value.experimentId)) ||
    (value.candidateId !== undefined && !isUuid(value.candidateId))
  ) {
    return { ok: false, code: "invalid_id", message: "Finding use ids must be UUIDs" };
  }
  if (input.grant.environmentId === undefined) {
    return { ok: false, code: "scope_mismatch", message: "Finding uses require an environment-scoped grant" };
  }
  if (!input.finding) {
    return { ok: false, code: "finding_missing", message: "Finding does not exist" };
  }
  if (input.finding.investigationId !== input.grant.investigationId) {
    return { ok: false, code: "scope_mismatch", message: "Finding is outside the grant investigation" };
  }
  if (input.findingTombstoned) {
    return { ok: false, code: "finding_tombstoned", message: "Finding is tombstoned" };
  }
  const target = hasExperiment ? input.experiment : input.candidate;
  if (!target) {
    return {
      ok: false,
      code: hasExperiment ? "experiment_missing" : "candidate_missing",
      message: hasExperiment ? "Experiment does not exist" : "Candidate does not exist",
    };
  }
  if (
    target.investigationId !== input.grant.investigationId ||
    target.environmentId !== input.grant.environmentId
  ) {
    return { ok: false, code: "scope_mismatch", message: "Finding use target is outside the grant scope" };
  }
  if (input.existingSameId) {
    if (!input.existingSameId.identical) {
      return { ok: false, code: "duplicate_id", message: "Finding use id already exists differently" };
    }
    return {
      ok: true,
      noOp: true,
      crossEnvironment: input.finding.environmentId !== input.grant.environmentId,
    };
  }
  if (input.existingSameKey) {
    return {
      ok: true,
      noOp: true,
      crossEnvironment: input.finding.environmentId !== input.grant.environmentId,
    };
  }
  return {
    ok: true,
    noOp: false,
    crossEnvironment: input.finding.environmentId !== input.grant.environmentId,
  };
}
