import type { FenceLike, GrantLike, GrantRef, LogicResult } from "./types.js";

export function validateGrantUse(
  grant: GrantLike | undefined,
  fence: FenceLike | undefined,
  ref: GrantRef,
  operation: string,
  nowMs: number,
  senderHex: string,
): LogicResult<{ bindHolder: boolean }> {
  if (!grant) {
    return { ok: false, code: "grant_not_found", message: "Execution grant not found" };
  }
  if (grant.revokedAtMs !== undefined) {
    const code = grant.revokeReason === "superseded" ? "grant_superseded" : "grant_revoked";
    return { ok: false, code, message: "Execution grant is no longer active" };
  }
  if (nowMs >= grant.expiresAtMs) {
    return { ok: false, code: "grant_expired", message: "Execution grant has expired" };
  }
  if (ref.attemptId !== grant.attemptId || ref.epoch !== grant.epoch) {
    return { ok: false, code: "stale_attempt", message: "Grant attempt or epoch does not match" };
  }
  if (!fence || fence.epoch !== grant.epoch || fence.grantId !== grant.id) {
    return { ok: false, code: "stale_epoch", message: "Grant is not current for its job" };
  }
  if (operation !== "heartbeat" && !grant.operations.includes(operation)) {
    return { ok: false, code: "op_not_allowed", message: "Operation is outside the grant scope" };
  }
  if (grant.holder !== undefined && grant.holder !== senderHex) {
    return { ok: false, code: "holder_mismatch", message: "Grant is bound to another identity" };
  }
  return { ok: true, bindHolder: grant.holder === undefined };
}

export function checkScope(
  grant: Pick<GrantLike, "investigationId" | "environmentId">,
  scope: { investigationId?: string; environmentId?: string },
): LogicResult<object> {
  if (
    scope.investigationId !== undefined &&
    scope.investigationId !== grant.investigationId
  ) {
    return { ok: false, code: "scope_mismatch", message: "Investigation is outside the grant scope" };
  }
  if (
    grant.environmentId !== undefined &&
    scope.environmentId !== undefined &&
    scope.environmentId !== grant.environmentId
  ) {
    return { ok: false, code: "scope_mismatch", message: "Environment is outside the grant scope" };
  }
  return { ok: true };
}

export interface BridgeIdentityLike {
  identityHex: string;
  role: string;
}

/** Every other "convex" identity loses bridge authority when the caller rotates in. */
export function planBridgeRotation(
  rows: readonly BridgeIdentityLike[],
  senderHex: string,
): { revokeHex: string[] } {
  return {
    revokeHex: rows
      .filter((row) => row.role === "convex" && row.identityHex !== senderHex)
      .map((row) => row.identityHex),
  };
}
