const MISSING_SANDBOX_GRACE_MS = 10 * 60_000;

export function sandboxReconcileDecision(args: {
  status: string;
  ageMs: number;
  investigationTerminal: boolean;
  hasSandbox: boolean;
  sandboxExists?: boolean;
}): "terminate" | "missing" | "ignore" {
  if (args.status === "ready" && args.investigationTerminal) return "terminate";
  const shouldCheck = args.status === "ready"
    || (args.status === "creating" && args.ageMs >= MISSING_SANDBOX_GRACE_MS);
  if (!shouldCheck) return "ignore";
  if (!args.hasSandbox || args.sandboxExists === false) return "missing";
  return "ignore";
}
