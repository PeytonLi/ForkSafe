import { GRANT_OPS } from "./constants.js";
import { isUuid } from "./ids.js";
import type { FenceLike, GrantLike, LogicResult } from "./types.js";

export interface GrantInstallInput extends Omit<GrantLike, "bytesUsed" | "revokedAtMs" | "revokeReason" | "holder"> {}

export function sameGrantFields(existing: GrantLike, input: GrantInstallInput): boolean {
  return (
    existing.id === input.id &&
    existing.jobId === input.jobId &&
    existing.attemptId === input.attemptId &&
    existing.epoch === input.epoch &&
    existing.investigationId === input.investigationId &&
    existing.environmentId === input.environmentId &&
    JSON.stringify(existing.operations) === JSON.stringify(input.operations) &&
    JSON.stringify(existing.artifactPrefixes) === JSON.stringify(input.artifactPrefixes) &&
    existing.maxBytes === input.maxBytes &&
    existing.expiresAtMs === input.expiresAtMs
  );
}

export function planGrantInstall(
  existingSameId: GrantLike | undefined,
  fence: FenceLike | undefined,
  input: GrantInstallInput,
  nowMs: number,
  existingForJob: GrantLike[] = [],
): LogicResult<{ noOp: boolean; supersededIds: string[] }> {
  if (existingSameId) {
    if (sameGrantFields(existingSameId, input)) {
      return { ok: true, noOp: true, supersededIds: [] };
    }
    return { ok: false, code: "grant_conflict", message: "Grant id is already installed with different fields" };
  }
  if (input.expiresAtMs <= nowMs) {
    return { ok: false, code: "grant_expired", message: "Grant expiry must be in the future" };
  }
  if (input.operations.some((operation) => !(GRANT_OPS as readonly string[]).includes(operation))) {
    return { ok: false, code: "invalid_scope", message: "Grant contains an unsupported operation" };
  }
  const ids = [
    input.id,
    input.jobId,
    input.attemptId,
    input.investigationId,
    ...(input.environmentId === undefined ? [] : [input.environmentId]),
  ];
  if (
    ids.some((id) => !isUuid(id)) ||
    !Number.isInteger(input.epoch) ||
    input.epoch < 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 0
  ) {
    return { ok: false, code: "invalid_id", message: "Grant ids or numeric scope are invalid" };
  }
  if (fence && input.epoch <= fence.epoch) {
    return { ok: false, code: "stale_epoch", message: "Grant epoch must advance the job fence" };
  }
  return {
    ok: true,
    noOp: false,
    supersededIds: existingForJob
      .filter((grant) => grant.id !== input.id && grant.revokedAtMs === undefined)
      .map((grant) => grant.id),
  };
}
