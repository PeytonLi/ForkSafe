import { createSandboxProvider } from "../src/index.js";

const args = process.argv.slice(2);
const runIndex = args.indexOf("--run");
const runId = runIndex >= 0 ? args[runIndex + 1] : undefined;
const dryRun = !args.includes("--yes");
const provider = createSandboxProvider();

const filter = runId ? { "forksafe.run": runId } : { "forksafe.project": "forksafe" as const };
const owned = await provider.listOwned(filter);
console.log(JSON.stringify({
  mode: dryRun ? "dry_run" : "execute",
  ownedCount: owned.length,
  sandboxes: owned.map((item) => ({ id: item.ref.id, state: item.state })),
}));
if (!dryRun) {
  for (const sandbox of owned) await provider.destroy(sandbox.ref);
  const remaining = await provider.listOwned(filter);
  console.log(JSON.stringify({ remainingCount: remaining.length }));
  if (remaining.length) process.exitCode = 1;
}
