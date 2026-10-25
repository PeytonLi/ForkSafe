import { classifyExperiment } from "./experimentStatus.js";

/** Agent environments start only after a real baseline failure. */
export function shouldStartAgents(outcome: { completed: boolean; failureKinds: string[] }): boolean {
  const status = classifyExperiment(outcome);
  return status === "physics_failure" || status === "constraint_violation";
}
