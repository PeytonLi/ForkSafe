import {
  IntegrationReadiness,
  type EnvConfig,
} from "@forksafe/contracts";
import { LiveFactoryAdapter, FixtureFactoryAdapter, type FactoryAdapter } from "./adapter.js";

export function factoryReadiness(env: EnvConfig, now = Date.now()): IntegrationReadiness {
  if (env.FACTORY_MODE === "fixture") return { name: "factory", mode: "fixture", detail: "Deterministic fixture adapter selected.", checkedAtMs: now };
  if (env.FACTORY_MODE === "cloud" && env.FACTORY_API_KEY) return { name: "factory", mode: "live", checkedAtMs: now };
  if (env.FACTORY_MODE === "cloud") return { name: "factory", mode: "blocked", detail: "FACTORY_API_KEY is required for cloud mode.", checkedAtMs: now };
  return { name: "factory", mode: "blocked", detail: `FACTORY_MODE=${env.FACTORY_MODE} is not supported by this adapter.`, checkedAtMs: now };
}

export function selectFactoryAdapter(env: EnvConfig): FactoryAdapter {
  if (env.FACTORY_MODE === "cloud" && env.FACTORY_API_KEY) return new LiveFactoryAdapter({ apiKey: env.FACTORY_API_KEY, modelId: env.FACTORY_MODEL });
  return new FixtureFactoryAdapter();
}
