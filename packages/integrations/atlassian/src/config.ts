import {
  EnvConfig,
  effectiveMode,
  missingForMode,
  type IntegrationMode,
  type IntegrationReadiness,
} from "@forksafe/contracts";
import { ConfluenceClient } from "./confluence.js";
import { basicAuthTransport, type AtlassianTransport } from "./http.js";
import { JiraClient } from "./jira.js";
import { fixtureTransport } from "./fixture-transport.js";

export class AtlassianBlockedError extends Error {
  constructor(readonly missingNames: string[]) {
    super(`Atlassian integration is blocked; missing: ${missingNames.join(", ")}`);
    this.name = "AtlassianBlockedError";
  }
}

export type AtlassianClients = {
  mode: IntegrationMode;
  jira: JiraClient;
  confluence: ConfluenceClient;
  readiness: IntegrationReadiness[];
};

export function atlassianReadiness(
  env: Record<string, string | undefined>,
  nowMs: number,
): IntegrationReadiness[] {
  const cfg = EnvConfig.parse(env);
  const mode = effectiveMode(cfg, "ATLASSIAN_MODE");
  const missing = missingForMode(cfg).ATLASSIAN_MODE ?? [];
  const detail =
    mode === "blocked"
      ? `Missing configuration: ${missing.join(", ")}`
      : undefined;
  return (["atlassian_jira", "atlassian_confluence"] as const).map((name) => ({
    name,
    mode,
    checkedAtMs: nowMs,
    ...(detail === undefined ? {} : { detail }),
  }));
}

export function createAtlassianClients(
  env: Record<string, string | undefined>,
  { fetch: fetchImpl }: { fetch?: typeof globalThis.fetch } = {},
): AtlassianClients {
  const cfg = EnvConfig.parse(env);
  const ready = atlassianReadiness(env, Date.now());
  const required = [
    "ATLASSIAN_SITE_URL",
    "ATLASSIAN_EMAIL",
    "ATLASSIAN_API_TOKEN",
    "ATLASSIAN_PROJECT_KEY",
  ];
  const missing = required.filter((name) => !env[name]);
  if (cfg.ATLASSIAN_MODE === "fixture") {
    const transport = fixtureTransport();
    return clients("fixture", transport, ready);
  }
  if (missing.length > 0) {
    const transport: AtlassianTransport = async () => {
      throw new AtlassianBlockedError(missing);
    };
    const readiness = ready.map((item) => ({
      ...item,
      mode: "blocked" as const,
      detail: `Missing configuration: ${missing.join(", ")}`,
    }));
    return clients("blocked", transport, readiness);
  }
  const transport = basicAuthTransport({
    siteUrl: cfg.ATLASSIAN_SITE_URL!,
    email: cfg.ATLASSIAN_EMAIL!,
    apiToken: cfg.ATLASSIAN_API_TOKEN!,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const mode = effectiveMode(cfg, "ATLASSIAN_MODE");
  return clients(mode, transport, ready);
}

export async function probeLive(
  current: AtlassianClients,
): Promise<AtlassianClients> {
  if (current.mode !== "live" && current.mode !== "local") return current;
  const readiness = [...current.readiness];
  const probes = [
    {
      name: "atlassian_jira",
      client: current.jira,
    },
    {
      name: "atlassian_confluence",
      client: current.confluence,
    },
  ] as const;
  await Promise.all(
    probes.map(async ({ name, client }) => {
      try {
        await client.probe();
      } catch (error) {
        const status =
          error !== null &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : 0;
        const index = readiness.findIndex((item) => item.name === name);
        if (index >= 0) {
          readiness[index] = {
            ...readiness[index]!,
            mode: "blocked",
            detail: `HTTP ${status}`,
          };
        }
      }
    }),
  );
  return { ...current, readiness };
}

function clients(
  mode: IntegrationMode,
  transport: AtlassianTransport,
  readiness: IntegrationReadiness[],
): AtlassianClients {
  return {
    mode,
    jira: new JiraClient(transport),
    confluence: new ConfluenceClient(transport),
    readiness,
  };
}
