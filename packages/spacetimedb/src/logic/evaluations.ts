import { EVALUATION_STATUSES } from "./constants.js";
import type { EvaluationLike, LogicResult } from "./types.js";

const terminalStatuses = new Set(["passed", "failed", "invalid"]);

export function planEvaluationWrite(
  existing: EvaluationLike | undefined,
  input: EvaluationLike,
  attemptId: string,
): LogicResult<{ action: "insert" | "update" }> {
  if (!(EVALUATION_STATUSES as readonly string[]).includes(input.status)) {
    return { ok: false, code: "invalid_status", message: "Evaluation status is invalid" };
  }
  if (!existing) return { ok: true, action: "insert" };
  if (terminalStatuses.has(existing.status)) {
    return { ok: false, code: "evaluation_final", message: "Evaluation is already terminal" };
  }
  if (existing.evaluatorAttemptId !== attemptId) {
    return { ok: false, code: "stale_attempt", message: "Evaluation belongs to another evaluator attempt" };
  }
  return { ok: true, action: "update" };
}
