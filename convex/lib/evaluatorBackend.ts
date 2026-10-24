export type EvaluatorBackend = "v1" | "v2" | "v3";

export function evaluatorBackend(snapshot = process.env.DAYTONA_EXECUTION_SNAPSHOT): EvaluatorBackend {
  if (snapshot?.startsWith("forksafe-exec-v3")) return "v3";
  return snapshot?.startsWith("forksafe-exec-v2") ? "v2" : "v1";
}

/** The evaluator signing seed is injected only into v3 evaluator sandboxes at create time. */
export function evaluatorSandboxEnv(
  purpose: string,
  snapshot: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  if (purpose !== "evaluator" || evaluatorBackend(snapshot) !== "v3") return undefined;
  const key = env.FORKSAFE_EVAL_SIGNING_KEY;
  if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key.trim())) return undefined;
  return { FORKSAFE_EVAL_SIGNING_KEY: key.trim(), FORKSAFE_REQUIRE_SIGNING: "1" };
}
