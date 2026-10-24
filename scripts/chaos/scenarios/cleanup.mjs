import { cleanupAll } from "../lib/cleanup.mjs";

export async function run(ctx) {
  const result = await cleanupAll();
  ctx.evidence.cleanupAll = result;
  ctx.checks.check(
    "CLEANUP_ALL",
    "all selected chaos investigations are cleaned and recorded runner groups are stopped",
    result.investigations.every((item) => item.complete)
      && result.runnerPids.every((item) => item.signal === "SIGTERM" || item.signal === "SIGKILL" || !item.error),
    {
      selectedInvestigations: result.selectedInvestigations,
      investigations: result.investigations,
      runnerPids: result.runnerPids,
      globalForksafeSandboxCount: result.globalForksafeSandboxCount,
      sandboxes: result.sandboxes,
    },
  );
}
