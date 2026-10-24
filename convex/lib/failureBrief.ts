import { isTaskFamily, TASK_FAMILY_SPECS } from "@forksafe/contracts";

const DETAIL_LIMIT = 400;
const FALLBACK = "The baseline run did not record a failure detail.";

export function failureSummaryFor(input: {
  taskFamily?: string;
  failureKinds?: string[];
  firstFailure?: { kind: string; tSec: number; detail: string } | null;
}): string {
  const detail = input.firstFailure?.detail;
  if (typeof detail === "string") {
    const trimmed = detail.trim();
    if (trimmed) return trimmed.length > DETAIL_LIMIT ? trimmed.slice(0, DETAIL_LIMIT) : trimmed;
  }
  const kinds = (input.failureKinds ?? []).flatMap((kind) => {
    const trimmed = typeof kind === "string" ? kind.trim() : "";
    return trimmed ? [trimmed] : [];
  });
  if (kinds.length) {
    const title = input.taskFamily && isTaskFamily(input.taskFamily)
      ? TASK_FAMILY_SPECS[input.taskFamily].title
      : undefined;
    const named = kinds.join(", ");
    return title
      ? `The baseline run of ${title} failed: ${named}.`
      : `The baseline run failed: ${named}.`;
  }
  return FALLBACK;
}
