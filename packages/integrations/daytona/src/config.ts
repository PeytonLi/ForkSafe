import { EnvConfig, effectiveMode, type IntegrationReadiness } from "@forksafe/contracts";
import type { DaytonaNetworkPolicy, SandboxPurpose } from "./types.js";

export type DaytonaConfig = {
  mode: "cloud" | "local";
  apiKey?: string;
  apiUrl: string;
  runnerSnapshot?: string;
  executionSnapshot?: string;
  runnerDomainAllowList?: string[];
  runnerOutboundProxyUrl?: string;
  maxActiveSandboxes: number;
  executionConcurrency: number;
  localImage: string;
  defaults: Record<SandboxPurpose, {
    cpu: number;
    memoryGiB: number;
    diskGiB: number;
    autoStopMinutes: number;
    autoDeleteMinutes: number;
  }>;
};

export function loadDaytonaConfig(env: Record<string, string | undefined> = process.env): DaytonaConfig {
  const parsed = EnvConfig.parse(env);
  if (parsed.DAYTONA_MODE !== "cloud" && parsed.DAYTONA_MODE !== "local") {
    throw new Error("daytona_mode_must_be_cloud_or_local");
  }
  return {
    mode: parsed.DAYTONA_MODE,
    apiKey: parsed.DAYTONA_API_KEY,
    apiUrl: parsed.DAYTONA_API_URL,
    runnerSnapshot: parsed.DAYTONA_RUNNER_SNAPSHOT,
    executionSnapshot: parsed.DAYTONA_EXECUTION_SNAPSHOT,
    runnerDomainAllowList: env.DAYTONA_RUNNER_DOMAIN_ALLOWLIST
      ?.split(",")
      .map((domain) => domain.trim())
      .filter(Boolean),
    runnerOutboundProxyUrl: env.DAYTONA_RUNNER_OUTBOUND_PROXY_URL?.trim() || undefined,
    maxActiveSandboxes: parsed.DAYTONA_MAX_ACTIVE_SANDBOXES,
    executionConcurrency: parsed.DAYTONA_EXECUTION_CONCURRENCY,
    localImage: env.DAYTONA_LOCAL_IMAGE ?? "python:3.12-slim",
    defaults: {
      runner: { cpu: 2, memoryGiB: 4, diskGiB: 10, autoStopMinutes: 30, autoDeleteMinutes: 60 },
      execution: { cpu: 2, memoryGiB: 4, diskGiB: 10, autoStopMinutes: 15, autoDeleteMinutes: 60 },
      evaluator: { cpu: 2, memoryGiB: 4, diskGiB: 10, autoStopMinutes: 15, autoDeleteMinutes: 60 },
      bridge: { cpu: 1, memoryGiB: 1, diskGiB: 3, autoStopMinutes: 10, autoDeleteMinutes: 60 },
    },
  };
}

export function runnerNetworkPolicy(config: DaytonaConfig): DaytonaNetworkPolicy | undefined {
  if (!config.runnerDomainAllowList?.length && !config.runnerOutboundProxyUrl) return undefined;
  return {
    purpose: "runner",
    ...(config.runnerDomainAllowList?.length ? { domainAllowList: config.runnerDomainAllowList } : {}),
    ...(config.runnerOutboundProxyUrl ? { outboundProxyUrl: config.runnerOutboundProxyUrl } : {}),
  };
}

export function toDaytonaNetworkOptions(
  purpose: SandboxPurpose,
  policy: DaytonaNetworkPolicy | undefined,
): {
  domainAllowList?: string;
  networkBlockAll?: boolean;
  outboundProxyUrl?: string;
} {
  if (!policy) return {};
  if (policy.purpose !== purpose) throw new Error("daytona_network_policy_purpose_mismatch");

  const domains = policy.domainAllowList?.map((domain) => domain.trim()).filter(Boolean) ?? [];
  const networkBlockAll = policy.networkBlockAll === true;
  if (domains.length && networkBlockAll) throw new Error("daytona_network_policy_conflict");

  const outboundProxyUrl = policy.outboundProxyUrl?.trim();
  return {
    ...(domains.length ? { domainAllowList: domains.join(",") } : {}),
    ...(networkBlockAll ? { networkBlockAll: true } : {}),
    ...(outboundProxyUrl ? { outboundProxyUrl } : {}),
  };
}

export function daytonaReadiness(
  config: DaytonaConfig,
  checkedAtMs = Date.now(),
): IntegrationReadiness {
  const env = {
    DAYTONA_MODE: config.mode,
    DAYTONA_API_KEY: config.apiKey,
  };
  const mode = effectiveMode(EnvConfig.parse(env), "DAYTONA_MODE");
  return {
    name: "daytona",
    mode,
    detail: config.mode === "local"
      ? "local docker adapter — does not count as Daytona use"
      : config.apiKey ? "Daytona cloud adapter configured" : "DAYTONA_API_KEY is missing",
    checkedAtMs,
  };
}

export function redactDaytonaError(error: unknown): Error {
  return new Error(error instanceof Error ? `daytona_request_failed:${error.name}` : "daytona_request_failed");
}
