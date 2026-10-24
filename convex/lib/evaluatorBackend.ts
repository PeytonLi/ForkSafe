export type EvaluatorBackend = "v1" | "v2";

export function evaluatorBackend(snapshot = process.env.DAYTONA_EXECUTION_SNAPSHOT): EvaluatorBackend {
  return snapshot?.startsWith("forksafe-exec-v2") ? "v2" : "v1";
}
