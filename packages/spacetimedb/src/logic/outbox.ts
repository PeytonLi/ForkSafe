import { OUTBOX_MAX_ATTEMPTS } from "./constants.js";
import type { LogicResult, OutboxLike } from "./types.js";

export interface OutboxInput {
  id: string;
  destination: string;
  idempotencyKey: string;
  operationId: string;
  payloadJson: string;
  sourceKind: string;
  sourceId: string;
}

export function planOutboxEnqueue(
  existingByKey: OutboxLike | undefined,
  input: OutboxInput,
): LogicResult<{ noOp: boolean }> {
  if (input.idempotencyKey.length < 8) {
    return { ok: false, code: "invalid_idempotency_key", message: "Idempotency key must contain at least 8 characters" };
  }
  if (existingByKey) {
    if (
      existingByKey.destination === input.destination &&
      existingByKey.payloadJson === input.payloadJson
    ) {
      return { ok: true, noOp: true };
    }
    return { ok: false, code: "idempotency_conflict", message: "Idempotency key is already used for different content" };
  }
  return { ok: true, noOp: false };
}

export function planOutboxFailure(
  entry: Pick<OutboxLike, "status" | "attempts">,
): { status: string; attempts: number } {
  const attempts = entry.attempts + 1;
  return {
    status: attempts >= OUTBOX_MAX_ATTEMPTS ? "dead" : entry.status,
    attempts,
  };
}
