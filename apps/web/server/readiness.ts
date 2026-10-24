import {
  EnvConfig,
  effectiveMode,
  missingForMode,
  type IntegrationMode,
  type IntegrationReadiness,
} from "@forksafe/contracts";

type Name = IntegrationReadiness["name"];

const MODE_VAR: Partial<Record<Name, string>> = {
  convex: "CONVEX_MODE",
  daytona: "DAYTONA_MODE",
  factory: "FACTORY_MODE",
  elastic: "ELASTIC_MODE",
  elastic_agent_builder: "ELASTIC_AGENT_BUILDER_MODE",
  atlassian_jira: "ATLASSIAN_MODE",
  atlassian_confluence: "ATLASSIAN_MODE",
};

export type Probe = (url: string, timeoutMs: number) => Promise<{ ok: boolean; status?: number; error?: string }>;

export const httpProbe: Probe = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message };
  }
};

/** Builds the /api/readiness report. Credential-gated integrations report
 *  `blocked` with the missing variable *names* (never values). Integrations
 *  without credentials (SpacetimeDB, simulator, evaluator) are probed over
 *  HTTP: unreachable means `blocked`, never `live`. Config-only `live` is
 *  labeled as "credentials present, not probed by web". */
export async function buildReadiness(
  rawEnv: Record<string, string | undefined>,
  probe: Probe = httpProbe,
  now = Date.now(),
): Promise<IntegrationReadiness[]> {
  const env = EnvConfig.parse(Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== "")));
  const missing = missingForMode(env);
  const out: IntegrationReadiness[] = [];
  const push = (name: Name, mode: IntegrationMode, detail: string) =>
    out.push({ name, mode, detail: detail.slice(0, 1000), checkedAtMs: now });

  for (const [name, modeVar] of Object.entries(MODE_VAR) as [Name, string][]) {
    const mode = effectiveMode(env, modeVar);
    const gaps = missing[modeVar] ?? [];
    const detail =
      mode === "blocked"
        ? `Missing ${gaps.join(", ")}`
        : mode === "live"
          ? `${modeVar}=cloud; credentials present, not probed by web`
          : mode === "not_implemented"
            ? `${modeVar}=disabled`
            : `${modeVar}=${(env as unknown as Record<string, string>)[modeVar]}`;
    push(name, mode, detail);
  }

  const probed = async (name: Name, modeVar: string, url: string, label: string) => {
    const configured = (env as unknown as Record<string, string>)[modeVar];
    if (configured === "fixture") return push(name, "fixture", `${modeVar}=fixture`);
    if (configured === "disabled") return push(name, "not_implemented", `${modeVar}=disabled`);
    const r = await probe(url, 1500);
    if (r.status === 404) return push(name, "blocked", `${label} not found at ${url} (HTTP 404)`);
    if (!r.ok) return push(name, "blocked", `${label} unreachable (${r.error ?? `HTTP ${r.status}`})`);
    push(name, configured === "local" ? "local" : "live", `${label} reachable (HTTP ${r.status})`);
  };

  const stdbHttp = env.SPACETIMEDB_URI.replace(/^ws/, "http").replace(/\/$/, "");
  await Promise.all([
    probed("spacetimedb", "SPACETIMEDB_MODE", `${stdbHttp}/v1/database/${env.SPACETIMEDB_DATABASE}`, `SpacetimeDB database ${env.SPACETIMEDB_DATABASE}`),
    probed("simulator", "SIMULATOR_MODE", `${env.SIMULATOR_URL.replace(/\/$/, "")}/health`, "Simulator"),
    probed("evaluator", "SIMULATOR_MODE", `${env.EVALUATOR_URL.replace(/\/$/, "")}/health`, "Evaluator"),
  ]);

  const artifactMode = env.ARTIFACT_MODE;
  push(
    "artifact_store",
    artifactMode === "fixture" ? "fixture" : artifactMode === "disabled" ? "not_implemented" : artifactMode === "local" ? "local" : effectiveMode(env, "CONVEX_MODE"),
    artifactMode === "local" ? `Local filesystem at ${env.ARTIFACT_ROOT}` : `ARTIFACT_MODE=${artifactMode} (Convex file storage)`,
  );

  const order: Name[] = ["convex", "spacetimedb", "daytona", "factory", "simulator", "evaluator", "artifact_store", "elastic", "elastic_agent_builder", "atlassian_jira", "atlassian_confluence"];
  return out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}
