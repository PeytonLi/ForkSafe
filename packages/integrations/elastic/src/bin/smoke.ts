import { createElasticClient, resolveConfig } from "../config.ts";
import { runSmoke, sanitizeSummary } from "../smoke.ts";

try {
  const env = resolveConfig();
  const client = createElasticClient(env);
  if (!client) throw new Error("Smoke client unavailable");
  try {
    const result = await runSmoke(env, client, { keep: process.argv.includes("--keep") });
    console.log(sanitizeSummary(result, env));
    if (result.agent.mode !== "live") process.exitCode = 1;
  } finally { await client.close(); }
} catch {
  console.error(JSON.stringify({ mode: "blocked", error: "Elastic live smoke failed; check cloud configuration, service availability and smoke cleanup" }));
  process.exitCode = 1;
}
