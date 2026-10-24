import type { LearningExperimentSummary } from "../services";
import { words } from "./tone";

export function plainOutcome(result: Pick<LearningExperimentSummary, "completed" | "completionTimeSec" | "firstFailure" | "failureKinds">): string {
  if (result.completed) return `placed the cube in ${result.completionTimeSec?.toFixed(1) ?? "?"} s`;
  if (result.firstFailure) {
    const time = `${result.firstFailure.tSec.toFixed(1)} s`;
    if (result.firstFailure.kind === "forbidden_contact" && /divider/i.test(result.firstFailure.detail)) {
      return `hit the divider at ${time}`;
    }
    return `${words(result.firstFailure.kind)} at ${time}`;
  }
  return result.failureKinds?.length ? words(result.failureKinds[0]!) : "did not finish";
}

export function outcomeSentence(
  before: Pick<LearningExperimentSummary, "completed" | "completionTimeSec" | "firstFailure" | "failureKinds">,
  after: Pick<LearningExperimentSummary, "completed" | "completionTimeSec" | "firstFailure" | "failureKinds">,
): string {
  return `Before: ${plainOutcome(before)}. After: ${plainOutcome(after)}.`;
}
