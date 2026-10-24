export type SimOutcome = { completed: boolean; failureKinds: string[]; completionTimeSec?: number };

export function classifyExperiment(result: SimOutcome):
  | "succeeded" | "physics_failure" | "constraint_violation" | "engine_error" | "invalid" {
  const kinds = new Set(result.failureKinds);
  if (kinds.has("invalid_run") || kinds.has("missing_artifact")) return "invalid";
  if (kinds.has("engine_error")) return "engine_error";
  if (["forbidden_contact", "joint_limit", "command_limit", "nonfinite_command"].some((kind) => kinds.has(kind))) return "constraint_violation";
  if (kinds.size > 0 || !result.completed) return "physics_failure";
  return "succeeded";
}

export function caseStatus(result: SimOutcome & { controllerSha256?: string }, expectedSha?: string): "passed" | "failed" | "invalid" {
  if (expectedSha && result.controllerSha256 !== expectedSha) return "invalid";
  const status = classifyExperiment(result);
  if (status === "succeeded") return "passed";
  if (status === "invalid" || status === "engine_error") return "invalid";
  return "failed";
}

/** PRD ranking: all required passed, fewer changed functions, lower median
 *  completion time, then stable candidate id. */
export function rankCandidates<T extends { id: string; allPassed: boolean; changedFunctions: number; medianCompletionTimeSec?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    Number(b.allPassed) - Number(a.allPassed)
    || a.changedFunctions - b.changedFunctions
    || (a.medianCompletionTimeSec ?? Number.POSITIVE_INFINITY) - (b.medianCompletionTimeSec ?? Number.POSITIVE_INFINITY)
    || a.id.localeCompare(b.id));
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Keeps replay payloads under the Convex document limit. */
export function compactReplay(result: Record<string, unknown>, maxBytes = 700_000): { result: Record<string, unknown>; truncated: boolean } {
  const frames = Array.isArray(result.frames) ? result.frames as Record<string, unknown>[] : [];
  const slim = frames.map((frame) => ({ ...frame, qvel: [], ctrl: [] }));
  let keep = slim;
  let truncated = false;
  while (keep.length > 1 && JSON.stringify({ ...result, frames: keep }).length > maxBytes) {
    keep = keep.filter((_, index) => index % 2 === 0 || index === keep.length - 1);
    truncated = true;
  }
  return { result: { ...result, frames: keep }, truncated };
}
