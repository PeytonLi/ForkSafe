/** Pure helpers for talking to SpacetimeDB over its HTTP API
 *  (`POST /v1/database/:name/call/:reducer`, `POST /v1/database/:name/sql`).
 *  Convex is the only process holding the bridge identity; runners never see it. */

export type SpacetimeMode = "live" | "local" | "fixture" | "blocked" | "not_implemented";

export type SpacetimeConfig = {
  mode: SpacetimeMode;
  httpBase: string;
  database: string;
  bridgeSecretPresent: boolean;
};

export function spacetimeConfig(env: Record<string, string | undefined> = process.env): SpacetimeConfig {
  const modeValue = env.SPACETIMEDB_MODE ?? "cloud";
  const uri = env.SPACETIMEDB_URI ?? (modeValue === "local" ? "ws://127.0.0.1:3000" : "wss://maincloud.spacetimedb.com");
  const database = env.SPACETIMEDB_DATABASE ?? "forksafe";
  const httpBase = uri.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/+$/, "");
  const bridgeSecretPresent = Boolean(env.FORKSAFE_BRIDGE_SECRET);
  let mode: SpacetimeMode;
  if (modeValue === "fixture") mode = "fixture";
  else if (modeValue === "disabled") mode = "not_implemented";
  else if (modeValue !== "cloud" && modeValue !== "local") mode = "not_implemented";
  else if (!uri.trim() || !database.trim() || !bridgeSecretPresent) mode = "blocked";
  else mode = modeValue === "cloud" ? "live" : "local";
  return { mode, httpBase, database, bridgeSecretPresent };
}

export function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Top-level reducer arguments keep their declared camelCase names, but
 *  nested product values (GrantRef, EvidenceInput, SimCaseInput, ...) are
 *  matched by snake_case field names by the SpacetimeDB JSON decoder. */
export function encodeReducerArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, item]) => [key, encodeNested(item)]));
}

export function encodeNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(encodeNested);
  if (value && typeof value === "object") {
    if ("some" in (value as Record<string, unknown>) && Object.keys(value as object).length === 1) {
      return { some: encodeNested((value as { some: unknown }).some) };
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [toSnakeCase(key), encodeNested(item)]));
  }
  return value;
}

/** `t.option(x)` is encoded as `{ some: x }` or `null`. */
export function option<T>(value: T | undefined | null): { some: T } | null {
  return value === undefined || value === null ? null : { some: value };
}

export class SpacetimeReducerError extends Error {
  constructor(readonly code: string, readonly status: number, detail: string) {
    super(`spacetime_reducer_error:${code}`);
    this.name = "SpacetimeReducerError";
    this.detail = detail.slice(0, 300);
  }
  readonly detail: string;
}

export function classifyReducerFailure(status: number, body: string): SpacetimeReducerError {
  const match = /^\s*([a-z_]+):/.exec(body);
  const code = match?.[1] ?? (status === 401 ? "unauthorized" : status === 404 ? "not_found" : `http_${status}`);
  return new SpacetimeReducerError(code, status, body);
}

export type SqlResultSet = { schema: { elements: { name: { some: string } | string }[] }; rows: unknown[][] };

export function decodeSqlRows(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload) || !payload.length) return [];
  const set = payload[0] as SqlResultSet;
  const names = set.schema.elements.map((element) =>
    typeof element.name === "string" ? element.name : element.name.some);
  return set.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, decodeSqlValue(row[index])])));
}

function decodeSqlValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("some" in record && Object.keys(record).length === 1) return decodeSqlValue(record.some);
    if ("none" in record && Object.keys(record).length === 1) return undefined;
  }
  return value;
}

export function sqlLiteral(value: string): string {
  if (!/^[A-Za-z0-9_.:/-]+$/.test(value)) throw new Error("sql_literal_rejected");
  return `'${value}'`;
}
