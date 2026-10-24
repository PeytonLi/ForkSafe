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

/** run_candidate argv for one signed case. Must stay a single allow-listed command
 *  (no shell operators): the Daytona policy rejects `&&`, quotes and redirects. */
export function signedCaseCommand(args: {
  runDir: string; controllerSha256: string; suite: "public" | "withheld"; caseId: string;
  candidateId: string; investigationId: string; attemptId: string;
}): string {
  return [
    "python3 -m evaluator.run_candidate",
    `--controller ${args.runDir}/controller/task_controller.py`,
    `--expected-sha256 ${args.controllerSha256}`,
    `--suite ${args.suite}`,
    `--case-ids ${args.caseId}`,
    `--candidate-id ${args.candidateId}`,
    `--investigation-id ${args.investigationId}`,
    `--evaluator-attempt-id ${args.attemptId}`,
    `--artifacts-dir ${args.runDir}/artifacts`,
    `--work-dir ${args.runDir}/work`,
    `--out ${args.runDir}/result.json`,
    ...(args.suite === "withheld" ? [`--withheld-manifest ${args.runDir}/withheld-manifest.json`, "--consume-withheld-manifest"] : []),
    "--case-wall-sec 120",
  ].join(" ");
}
