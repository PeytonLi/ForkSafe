import { createElasticClient, resolveConfig } from "../config.ts";
import { redactTranscript, runAgentSmoke, type AgentSmokeClient } from "../agentSmoke.ts";
import { KibanaError } from "../kibana.ts";

const env = resolveConfig();
try {
  const client = createElasticClient(env);
  if (!client) throw new Error("Elastic client unavailable; set ELASTIC_MODE=cloud with ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY");
  try {
    const result = await runAgentSmoke(env, client as unknown as AgentSmokeClient);
    console.log(redactTranscript(result, env));
    if (!result.ok) process.exitCode = 1;
  } finally { await client.close(); }
} catch (error) {
  const detail = error instanceof KibanaError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "unknown error";
  console.error(redactTranscript({ mode: "blocked", error: `Elastic agent smoke failed: ${detail}` }, env));
  process.exitCode = 1;
}
