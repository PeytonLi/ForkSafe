import { z } from "zod";
import { IntegrationMode } from "./enums.js";

const mode = (def: string) =>
  z
    .enum(["cloud", "local", "fixture", "disabled"])
    .default(def as "cloud" | "local" | "fixture" | "disabled");

/** Validated process configuration. Missing values are reported by name
 *  through `missingForMode`; the doctor command prints names only. */
export const EnvConfig = z.object({
  APP_MODE: z.enum(["local", "cloud"]).default("cloud"),
  WEB_PORT: z.coerce.number().int().default(5173),

  CONVEX_MODE: mode("cloud"),
  CONVEX_URL: z.string().optional(),
  VITE_CONVEX_URL: z.string().optional(),
  CONVEX_SITE_URL: z.string().optional(),
  CONVEX_ADMIN_KEY: z.string().optional(),
  CONVEX_DEPLOY_KEY: z.string().optional(),

  DAYTONA_MODE: mode("cloud"),
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_API_URL: z.string().default("https://app.daytona.io/api"),
  DAYTONA_RUNNER_SNAPSHOT: z.string().optional(),
  DAYTONA_EXECUTION_SNAPSHOT: z.string().optional(),
  DAYTONA_MAX_ACTIVE_SANDBOXES: z.coerce.number().int().default(5),
  DAYTONA_EXECUTION_CONCURRENCY: z.coerce.number().int().default(3),

  RUNNER_MODE: mode("cloud"),
  ARTIFACT_MODE: mode("cloud"),
  ARTIFACT_ROOT: z.string().default("./var/artifacts"),
  RUNNER_CALLBACK_SECRET: z.string().optional(),
  INTEGRATION_SHARED_SECRET: z.string().optional(),

  SIMULATOR_MODE: mode("cloud"),
  SIMULATOR_URL: z.string().default("http://127.0.0.1:8000"),
  EVALUATOR_URL: z.string().default("http://127.0.0.1:8001"),

  SPACETIMEDB_MODE: mode("cloud"),
  SPACETIMEDB_URI: z.string().default("wss://maincloud.spacetimedb.com"),
  SPACETIMEDB_DATABASE: z.string().default("forksafe"),

  FACTORY_MODE: mode("cloud"),
  FACTORY_API_KEY: z.string().optional(),
  FACTORY_MODEL: z.string().optional(),

  ELASTIC_MODE: mode("cloud"),
  ELASTICSEARCH_URL: z.string().optional(),
  ELASTICSEARCH_API_KEY: z.string().optional(),
  ELASTIC_AGENT_BUILDER_MODE: mode("disabled"),
  KIBANA_URL: z.string().optional(),
  KIBANA_API_KEY: z.string().optional(),

  ATLASSIAN_MODE: mode("cloud"),
  ATLASSIAN_SITE_URL: z.string().optional(),
  ATLASSIAN_EMAIL: z.string().optional(),
  ATLASSIAN_API_TOKEN: z.string().optional(),
  ATLASSIAN_PROJECT_KEY: z.string().optional(),
  FORGE_APP_ID: z.string().optional(),

  MAX_ENVIRONMENTS: z.coerce.number().int().default(10),
  DEFAULT_ENVIRONMENTS: z.coerce.number().int().default(3),
  MAX_ACTIVE_MODEL_CALLS: z.coerce.number().int().default(4),
});
export type EnvConfig = z.infer<typeof EnvConfig>;

/** Env var names that must be non-empty for each integration's live mode. */
export const REQUIRED_FOR_MODE: Record<string, Record<string, string[]>> = {
  CONVEX_MODE: {
    cloud: ["CONVEX_URL", "CONVEX_ADMIN_KEY", "VITE_CONVEX_URL"],
    local: ["CONVEX_URL", "VITE_CONVEX_URL"],
  },
  DAYTONA_MODE: { cloud: ["DAYTONA_API_KEY"] },
  FACTORY_MODE: { cloud: ["FACTORY_API_KEY"] },
  ELASTIC_MODE: {
    cloud: ["ELASTICSEARCH_URL", "ELASTICSEARCH_API_KEY"],
    local: ["ELASTICSEARCH_URL"],
  },
  ELASTIC_AGENT_BUILDER_MODE: {
    cloud: ["KIBANA_URL", "KIBANA_API_KEY"],
  },
  ATLASSIAN_MODE: {
    cloud: [
      "ATLASSIAN_SITE_URL",
      "ATLASSIAN_EMAIL",
      "ATLASSIAN_API_TOKEN",
      "ATLASSIAN_PROJECT_KEY",
    ],
  },
};

export function missingForMode(env: EnvConfig): Record<string, string[]> {
  const missing: Record<string, string[]> = {};
  for (const [modeVar, perMode] of Object.entries(REQUIRED_FOR_MODE)) {
    const active = (env as Record<string, unknown>)[modeVar] as string;
    const required = perMode[active] ?? [];
    const gaps = required.filter((name) => {
      const v = (env as Record<string, unknown>)[name];
      return v === undefined || v === "";
    });
    if (gaps.length) missing[modeVar] = gaps;
  }
  return missing;
}

export function effectiveMode(env: EnvConfig, modeVar: string): IntegrationMode {
  const active = (env as unknown as Record<string, string>)[modeVar];
  const missing = (missingForMode(env)[modeVar] ?? []).length > 0;
  if (active === "disabled") return "not_implemented";
  if (active === "fixture") return "fixture";
  if (active === "local") return "local";
  return missing ? "blocked" : "live";
}
