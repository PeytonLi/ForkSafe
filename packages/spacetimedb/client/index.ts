import { DbConnection, reducers, tables } from "./module_bindings/index.js";
import type { DbConnection as DbConnectionType } from "./module_bindings/index.js";

export { DbConnection, reducers, tables };
export * from "./decoders.js";

type Builder = ReturnType<typeof DbConnection.builder>;
export type OnDisconnect = Parameters<Builder["onDisconnect"]>[0];

export interface ConnectForkSafeOptions {
  uri: string;
  database: string;
  token?: string;
  onDisconnect?: OnDisconnect;
}

export interface ConnectedForkSafe {
  conn: DbConnectionType;
  identity: string;
  token: string;
}

export function connectForkSafe(
  { uri, database, token, onDisconnect }: ConnectForkSafeOptions,
): Promise<ConnectedForkSafe> {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      let builder = DbConnection.builder()
        .withUri(uri)
        .withDatabaseName(database)
        .withToken(token)
        .onConnect((conn, identity, authToken) => {
          if (settled) return;
          settled = true;
          resolve({ conn, identity: identity.toHexString(), token: authToken });
        })
        .onConnectError((_ctx, error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      if (onDisconnect) builder = builder.onDisconnect(onDisconnect);
      builder.build();
    } catch (error) {
      settled = true;
      reject(error);
    }
  });
}

export type SpacetimeMode = "cloud" | "local" | "fixture" | "not_implemented";
export interface SpacetimeConfig {
  uri: string;
  database: string;
  mode: SpacetimeMode;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SpacetimeConfig {
  const modeValue = env.SPACETIMEDB_MODE;
  const mode: SpacetimeMode =
    modeValue === "cloud" || modeValue === "local" || modeValue === "fixture"
      ? modeValue
      : modeValue === undefined
        ? "cloud"
        : "not_implemented";
  return {
    uri:
      env.SPACETIMEDB_URI ??
      (mode === "local" ? "ws://127.0.0.1:3000" : "wss://maincloud.spacetimedb.com"),
    database: env.SPACETIMEDB_DATABASE ?? "forksafe",
    mode,
  };
}

export async function spacetimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
  probe = true,
) {
  const config = configFromEnv(env);
  const checkedAtMs = Date.now();
  if (config.mode === "fixture") {
    return { name: "spacetimedb" as const, mode: "fixture" as const, checkedAtMs };
  }
  if (config.mode === "not_implemented") {
    return { name: "spacetimedb" as const, mode: "not_implemented" as const, checkedAtMs };
  }
  if (!config.uri.trim() || !config.database.trim()) {
    return {
      name: "spacetimedb" as const,
      mode: "blocked" as const,
      detail: "SpacetimeDB URI or database is not configured",
      checkedAtMs,
    };
  }
  if (!probe) {
    return {
      name: "spacetimedb" as const,
      mode: "blocked" as const,
      detail: "SpacetimeDB connection probe was skipped",
      checkedAtMs,
    };
  }
  try {
    const connected = await connectForkSafe({
      uri: config.uri,
      database: config.database,
      token: env.SPACETIMEDB_TOKEN,
    });
    connected.conn.disconnect();
    return {
      name: "spacetimedb" as const,
      mode: config.mode === "cloud" ? ("live" as const) : ("local" as const),
      checkedAtMs,
    };
  } catch (error) {
    return {
      name: "spacetimedb" as const,
      mode: "blocked" as const,
      detail: error instanceof Error ? error.message.slice(0, 1_000) : "Connection failed",
      checkedAtMs,
    };
  }
}

export function subscribeInvestigation(conn: DbConnectionType, investigationId: string) {
  return new Promise<ReturnType<ReturnType<DbConnectionType["subscriptionBuilder"]>["subscribe"]>>(
    (resolve, reject) => {
      let handle:
        | ReturnType<ReturnType<DbConnectionType["subscriptionBuilder"]>["subscribe"]>
        | undefined;
      try {
        handle = conn
          .subscriptionBuilder()
          .onApplied(() => {
            if (handle) resolve(handle);
          })
          .onError(() => reject(new Error("SpacetimeDB subscription failed")))
          .subscribe([
            tables.finding.where((row) => row.investigationId.eq(investigationId)),
            tables.evidence,
            tables.candidate.where((row) => row.investigationId.eq(investigationId)),
            tables.evaluation.where((row) => row.investigationId.eq(investigationId)),
            tables.humanReview,
            tables.experiment.where((row) => row.investigationId.eq(investigationId)),
            tables.baseline,
            tables.baselineRequirement,
            tables.experimentIdentity.where((row) => row.investigationId.eq(investigationId)),
            tables.findingUse.where((row) => row.findingInvestigationId.eq(investigationId)),
            tables.executionGrant,
            tables.revisionHead,
            tables.controllerRevision,
            tables.revisionLease,
            tables.outboxEntry,
            tables.tombstone,
          ]);
      } catch (error) {
        reject(error);
      }
    },
  );
}

export class ForkSafeReducers {
  constructor(private readonly conn: DbConnectionType) {}

  registerBridge(args: Parameters<DbConnectionType["reducers"]["registerBridge"]>[0]) {
    return this.conn.reducers.registerBridge(args);
  }

  unregisterBridge() {
    return this.conn.reducers.unregisterBridge({});
  }

  installGrant(args: Parameters<DbConnectionType["reducers"]["installGrant"]>[0]) {
    return this.conn.reducers.installGrant(args);
  }

  revokeGrant(args: Parameters<DbConnectionType["reducers"]["revokeGrant"]>[0]) {
    return this.conn.reducers.revokeGrant(args);
  }

  heartbeat(args: Parameters<DbConnectionType["reducers"]["heartbeat"]>[0]) {
    return this.conn.reducers.heartbeat(args);
  }

  acquireRevisionLease(args: Parameters<DbConnectionType["reducers"]["acquireRevisionLease"]>[0]) {
    return this.conn.reducers.acquireRevisionLease(args);
  }

  renewRevisionLease(args: Parameters<DbConnectionType["reducers"]["renewRevisionLease"]>[0]) {
    return this.conn.reducers.renewRevisionLease(args);
  }

  releaseRevisionLease(args: Parameters<DbConnectionType["reducers"]["releaseRevisionLease"]>[0]) {
    return this.conn.reducers.releaseRevisionLease(args);
  }

  commitRevision(args: Parameters<DbConnectionType["reducers"]["commitRevision"]>[0]) {
    return this.conn.reducers.commitRevision(args);
  }

  recordArtifact(args: Parameters<DbConnectionType["reducers"]["recordArtifact"]>[0]) {
    return this.conn.reducers.recordArtifact(args);
  }

  recordExperiment(args: Parameters<DbConnectionType["reducers"]["recordExperiment"]>[0]) {
    return this.conn.reducers.recordExperiment(args);
  }

  registerBaseline(args: Parameters<DbConnectionType["reducers"]["registerBaseline"]>[0]) {
    return this.conn.reducers.registerBaseline(args);
  }

  commitExperiment(args: Parameters<DbConnectionType["reducers"]["commitExperiment"]>[0]) {
    return this.conn.reducers.commitExperiment(args);
  }

  recordFinding(args: Parameters<DbConnectionType["reducers"]["recordFinding"]>[0]) {
    return this.conn.reducers.recordFinding(args);
  }

  recordFindingUse(args: Parameters<DbConnectionType["reducers"]["recordFindingUse"]>[0]) {
    return this.conn.reducers.recordFindingUse(args);
  }

  submitCandidate(args: Parameters<DbConnectionType["reducers"]["submitCandidate"]>[0]) {
    return this.conn.reducers.submitCandidate(args);
  }

  recordEvaluation(args: Parameters<DbConnectionType["reducers"]["recordEvaluation"]>[0]) {
    return this.conn.reducers.recordEvaluation(args);
  }

  recordReview(args: Parameters<DbConnectionType["reducers"]["recordReview"]>[0]) {
    return this.conn.reducers.recordReview(args);
  }

  outboxEnqueue(args: Parameters<DbConnectionType["reducers"]["outboxEnqueue"]>[0]) {
    return this.conn.reducers.outboxEnqueue(args);
  }

  outboxMarkDelivered(args: Parameters<DbConnectionType["reducers"]["outboxMarkDelivered"]>[0]) {
    return this.conn.reducers.outboxMarkDelivered(args);
  }

  outboxMarkFailed(args: Parameters<DbConnectionType["reducers"]["outboxMarkFailed"]>[0]) {
    return this.conn.reducers.outboxMarkFailed(args);
  }

  recordTombstone(args: Parameters<DbConnectionType["reducers"]["recordTombstone"]>[0]) {
    return this.conn.reducers.recordTombstone(args);
  }
}

export type { DbConnectionType };
