export const HEARTBEAT_INTERVAL_MS = 5_000;
export const LEASE_EXPIRY_MS = 30_000;
export const MAX_ATTEMPTS = 2;
export const GRANT_INSTALL_TIMEOUT_MS = 15_000;
export const HARD_STOP_DEADLINE_MS = 30_000;
export const MODEL_TURN_MAX_MS = 600_000;
export const ARTIFACT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const LOG_TAIL_MAX_BYTES = 65_536;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readLimits(env: Record<string, string | undefined> = process.env) {
  return {
    maxActiveSandboxes: positiveInteger(env.DAYTONA_MAX_ACTIVE_SANDBOXES, 5),
    maxActiveModelCalls: positiveInteger(env.MAX_ACTIVE_MODEL_CALLS, 4),
    defaultEnvironments: positiveInteger(env.DEFAULT_ENVIRONMENTS, 3),
    maxEnvironments: positiveInteger(env.MAX_ENVIRONMENTS, 10),
    executionConcurrency: positiveInteger(env.DAYTONA_EXECUTION_CONCURRENCY, 3),
  };
}
