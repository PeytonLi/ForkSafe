import { Daytona } from "@daytonaio/sdk";
import { loadDaytonaConfig } from "./config.js";
import { BlockedError, type SandboxProvider } from "./types.js";
import { CloudDaytonaProvider } from "./cloud.js";
import { LocalDockerProvider } from "./local.js";

export * from "./types.js";
export * from "./config.js";
export * from "./policy.js";
export { CloudDaytonaProvider } from "./cloud.js";
export { LocalDockerProvider } from "./local.js";

export function createSandboxProvider(env: Record<string, string | undefined> = process.env): SandboxProvider {
  const config = loadDaytonaConfig(env);
  if (config.mode === "local") return new LocalDockerProvider(config);
  if (!config.apiKey) throw new BlockedError();
  return new CloudDaytonaProvider(new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
  }), config);
}

export function createDaytonaProvider(env: Record<string, string | undefined> = process.env): SandboxProvider {
  return createSandboxProvider(env);
}

export function sandboxLabels(spec: {
  operationId: string;
  purpose: import("./types.js").SandboxPurpose;
  investigationId: string;
  environmentId?: string;
  attemptId?: string;
}): import("./types.js").SandboxLabels {
  return {
    "forksafe.project": "forksafe",
    "forksafe.operation": spec.operationId,
    "forksafe.purpose": spec.purpose,
    "forksafe.investigation": spec.investigationId,
    ...(spec.environmentId ? { "forksafe.environment": spec.environmentId } : {}),
    ...(spec.attemptId ? { "forksafe.attempt": spec.attemptId } : {}),
  };
}
