import { Client } from "@elastic/elasticsearch";
import { EnvConfig, effectiveMode, missingForMode, type IntegrationReadiness } from "@forksafe/contracts";

export function resolveConfig(input: EnvConfig = EnvConfig.parse(process.env)) {
  const env = EnvConfig.parse(input);
  if (env.ELASTIC_MODE === "local" && !env.ELASTICSEARCH_URL) env.ELASTICSEARCH_URL = "http://127.0.0.1:9200";
  return env;
}

function readiness(input: EnvConfig, now: number, agent: boolean): IntegrationReadiness {
  const env = resolveConfig(input);
  const key = agent ? "ELASTIC_AGENT_BUILDER_MODE" : "ELASTIC_MODE";
  const missing = missingForMode(env)[key] ?? [];
  return { name: agent ? "elastic_agent_builder" : "elastic", mode: effectiveMode(env, key),
    detail: missing.length ? `Missing: ${missing.join(", ")}` : undefined, checkedAtMs: now };
}
export const elasticReadiness = (env: EnvConfig, now: number) => readiness(env, now, false);
export const agentBuilderReadiness = (env: EnvConfig, now: number) => readiness(env, now, true);

export function createElasticClient(input?: EnvConfig): Client | undefined {
  const env = resolveConfig(input);
  const mode = elasticReadiness(env, 0).mode;
  if (mode !== "live" && mode !== "local") return undefined;
  return new Client({ node: env.ELASTICSEARCH_URL!, ...(mode === "live" ? { auth: { apiKey: env.ELASTICSEARCH_API_KEY! } } : {}) });
}
export async function probeElastic(client: { ping(): Promise<unknown> }) {
  try { await client.ping(); return { mode: "live" as const }; }
  catch { return { mode: "blocked" as const, reason: "Elastic probe failed" }; }
}
export class BlockedError extends Error {
  readonly mode = "blocked";
  constructor() { super("Elastic indexing unavailable"); this.name = "BlockedError"; }
}
