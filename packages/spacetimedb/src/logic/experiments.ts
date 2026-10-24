import { canonicalJson, sha256Hex } from "./hash.js";
import { isUuid } from "./ids.js";
import type { LogicResult } from "./types.js";

export interface ExperimentIdentityInput {
  controllerSha256: string;
  suite: string;
  caseId: string;
  seed: number;
  sceneOverridesJson: string;
  assetsSha256: string;
  engineVersion: string;
}

export function experimentIdentity(input: ExperimentIdentityInput): string {
  return sha256Hex(canonicalJson({
    v: "forksafe.experiment.v1",
    controllerSha256: input.controllerSha256,
    suite: input.suite,
    caseId: input.caseId,
    seed: input.seed,
    sceneOverrides: JSON.parse(input.sceneOverridesJson) as unknown,
    assetsSha256: input.assetsSha256,
    engineVersion: input.engineVersion,
  }));
}

export interface ExperimentIdentityRow {
  experimentId: string;
  investigationId: string;
  identityHash: string;
  authorClass: "evaluator" | "swarm";
  role: "canonical" | "duplicate" | "replication";
  canonicalExperimentId: string;
  replicationOfExperimentId?: string;
}

export interface ExperimentCommitInput {
  id: string;
  investigationId: string;
  authorClass: "evaluator" | "swarm";
  identityHash: string;
  replicationOf?: string;
  replicationReason?: string;
}

export function planExperimentCommit(input: {
  existingExperimentSameId?: { identical: boolean };
  existingIdentitySameId?: Pick<ExperimentIdentityRow, "identityHash" | "role">;
  canonicalForScope?: Pick<ExperimentIdentityRow, "experimentId" | "canonicalExperimentId" | "identityHash" | "investigationId" | "authorClass" | "role">;
  replicationTarget?: Pick<ExperimentIdentityRow, "identityHash" | "investigationId" | "authorClass">;
  input: ExperimentCommitInput;
}): LogicResult<{
  action: "noop" | "insert_canonical" | "alias_duplicate" | "insert_replication";
  canonicalExperimentId?: string;
}> {
  const { existingExperimentSameId, existingIdentitySameId, canonicalForScope, replicationTarget } = input;
  const value = input.input;
  if (
    (value.replicationReason !== undefined && value.replicationOf === undefined) ||
    (value.replicationOf !== undefined && value.replicationReason === undefined) ||
    (value.replicationReason !== undefined &&
      (value.replicationReason.trim().length < 1 || value.replicationReason.length > 1_000)) ||
    value.replicationOf === value.id
  ) {
    return { ok: false, code: "invalid_replication", message: "Replication requires a distinct target and reason" };
  }
  if (existingExperimentSameId) {
    return existingExperimentSameId.identical
      ? { ok: true, action: "noop", canonicalExperimentId: value.id }
      : { ok: false, code: "duplicate_id", message: "Experiment id already exists with different fields" };
  }
  if (existingIdentitySameId) {
    if (
      existingIdentitySameId.role === "duplicate" &&
      existingIdentitySameId.identityHash === value.identityHash
    ) {
      return { ok: true, action: "noop", canonicalExperimentId: value.id };
    }
    return { ok: false, code: "duplicate_id", message: "Experiment id already has identity metadata" };
  }
  if (value.replicationOf !== undefined) {
    if (!replicationTarget) {
      return { ok: false, code: "experiment_missing", message: "Replication target does not exist" };
    }
    if (
      replicationTarget.investigationId !== value.investigationId ||
      replicationTarget.authorClass !== value.authorClass ||
      replicationTarget.identityHash !== value.identityHash
    ) {
      return { ok: false, code: "replication_mismatch", message: "Replication target identity does not match" };
    }
    return { ok: true, action: "insert_replication", canonicalExperimentId: value.id };
  }
  if (
    canonicalForScope &&
    canonicalForScope.role === "canonical" &&
    canonicalForScope.investigationId === value.investigationId &&
    canonicalForScope.authorClass === value.authorClass &&
    canonicalForScope.identityHash === value.identityHash
  ) {
    return {
      ok: true,
      action: "alias_duplicate",
      canonicalExperimentId: canonicalForScope.canonicalExperimentId,
    };
  }
  return { ok: true, action: "insert_canonical", canonicalExperimentId: value.id };
}

export function validExperimentIdentityInput(input: ExperimentCommitInput): boolean {
  return isUuid(input.id) && isUuid(input.investigationId) && /^[0-9a-f]{64}$/.test(input.identityHash) &&
    (input.replicationOf === undefined || isUuid(input.replicationOf));
}
