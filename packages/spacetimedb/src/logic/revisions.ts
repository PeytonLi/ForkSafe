import type { LogicResult, RevisionHeadLike } from "./types.js";

export function checkExpectedHead(
  head: RevisionHeadLike | undefined,
  expectedHeadRevisionId: string | undefined,
): LogicResult<{ ok: true }> {
  if (!head) {
    return expectedHeadRevisionId === undefined
      ? { ok: true }
      : { ok: false, code: "revision_conflict", message: "Expected revision head does not exist" };
  }
  return expectedHeadRevisionId === head.headRevisionId
    ? { ok: true }
    : { ok: false, code: "revision_conflict", message: "Revision head changed" };
}
