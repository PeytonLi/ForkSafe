export const HEARTBEAT_INTERVAL_MS = 5_000;
/** Attempt leases must cover claim + Factory session open before the first heartbeat. */
export const LEASE_EXPIRY_MS = 120_000;
export const MAX_ATTEMPTS = 3;
export const GRANT_INSTALL_TIMEOUT_MS = 15_000;
export const HARD_STOP_DEADLINE_MS = 30_000;
export const MODEL_TURN_MAX_MS = 600_000;
export const ARTIFACT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const LOG_TAIL_MAX_BYTES = 65_536;
/** SpacetimeDB grants outlive single heartbeats; Convex revokes them explicitly. */
export const GRANT_TTL_MS = 20 * 60_000;
export const RUNNER_CREDENTIAL_TTL_MS = 60 * 60_000;
export const RUNNER_POOL_LEASE_MS = 90_000;
export const MAX_FINALISTS = 3;
export const MAX_TURNS_PER_ENVIRONMENT = 6;

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
