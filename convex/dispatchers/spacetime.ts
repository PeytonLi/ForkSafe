import {
  CandidateEvaluation,
  ControllerCandidate,
  Finding,
  HumanReview,
  ExperimentResult,
} from "@forksafe/contracts";
import { spacetimeHttpBase } from "../lib/spacetime.js";

type Environment = Record<string, string | undefined>;
type Row = Record<string, unknown>;

export class SpacetimeUnavailable extends Error {
  readonly transient = true;

  constructor() {
    super("SpacetimeDB is temporarily unavailable");
    this.name = "SpacetimeUnavailable";
  }
}

export class SpacetimeRejected extends Error {
  readonly transient = false;

  constructor(readonly code: string) {
    super(`SpacetimeDB rejected the request (${code})`);
    this.name = "SpacetimeRejected";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOMBSTONE_KINDS = new Set(["finding", "candidate", "evidence", "artifact"]);
const NON_TOMBSTONE_KINDS = new Set(["experiment_result", "evaluation"]);
const bridgeTokens = new Map<string, string>();
const bridgeRegistrations = new Map<string, Promise<void>>();

export class SpacetimeClient {
  private readonly uri: string;
  private readonly database: string;

  constructor(
    private readonly env: Environment = runtimeEnvironment(),
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    const configuredUri = env.SPACETIMEDB_URI ?? "";
    this.database = env.SPACETIMEDB_DATABASE ?? "";
    if (!configuredUri.trim()) throw new SpacetimeUnavailable();
    this.uri = spacetimeHttpBase(configuredUri);
    if (!this.database) throw new SpacetimeUnavailable();
  }

  async sql(query: string): Promise<Row[]> {
    const response = await this.request(
      `/v1/database/${encodeURIComponent(this.database)}/sql`,
      { method: "POST", headers: { "Content-Type": "text/plain" }, body: query },
      true,
    );
    return decodeSqlResponse(response);
  }

  async callReducer(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request(
      `/v1/database/${encodeURIComponent(this.database)}/call/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      },
      true,
    );
  }

  async getFinding(id: string): Promise<Finding | null> {
    const findingId = safeUuid(id);
    const rows = await this.sql(`SELECT * FROM finding WHERE id = '${findingId}'`);
    if (!rows[0]) return null;
    const evidenceRows = await this.sql(`SELECT * FROM evidence WHERE finding_id = '${findingId}'`);
    const ordered = evidenceRows.sort((left, right) => numeric(left.ordinal) - numeric(right.ordinal));
    return Finding.parse({
      id: rows[0].id,
      investigationId: rows[0].investigationId,
      environmentId: rows[0].environmentId,
      ...(rows[0].sessionId === undefined ? {} : { sessionId: rows[0].sessionId }),
      kind: rows[0].kind,
      summary: rows[0].summary,
      evidence: ordered.map((row) => ({
        kind: row.kind,
        locator: parseJsonRecord(row.locatorJson),
        ...optionalField(row, "artifactId"),
        ...optionalField(row, "experimentId"),
        ...optionalField(row, "excerpt"),
      })),
      createdAtMs: numeric(rows[0].createdAtMs),
    });
  }

  async getExperiment(id: string): Promise<ExperimentResult | null> {
    const row = (await this.sql(`SELECT * FROM experiment WHERE id = '${safeUuid(id)}'`))[0];
    return row ? ExperimentResult.parse(mapExperiment(row)) : null;
  }

  async getCandidate(id: string): Promise<ControllerCandidate | null> {
    const row = (await this.sql(`SELECT * FROM candidate WHERE id = '${safeUuid(id)}'`))[0];
    if (!row) return null;
    const candidateId = safeUuid(id);
    const [evaluations, reviews, tombstoned] = await Promise.all([
      this.sql(`SELECT * FROM evaluation WHERE candidate_id = '${candidateId}'`),
      this.sql(`SELECT * FROM human_review WHERE candidate_id = '${candidateId}'`),
      this.isTombstoned("candidate", candidateId),
    ]);
    const status = tombstoned
      ? "withdrawn"
      : reviews.some((review) => review.decision === "rejected")
        ? "rejected"
        : evaluations.some((evaluation) => ["passed", "failed", "invalid"].includes(String(evaluation.status)))
          ? "evaluated"
          : evaluations.some((evaluation) => ["queued", "running"].includes(String(evaluation.status)))
            ? "evaluating"
            : "submitted";
    return ControllerCandidate.parse({
      id: row.id,
      investigationId: row.investigationId,
      environmentId: row.environmentId,
      status,
      controllerSha256: row.controllerSha256,
      sourceArtifactId: row.sourceArtifactId,
      changedFunctions: row.changedFunctions,
      basedOnFindings: row.basedOnFindings,
      submittedByAttemptId: row.submittedByAttemptId,
      submittedAtMs: numeric(row.submittedAtMs),
      ...optionalField(row, "rationale"),
    });
  }

  async getEvaluation(id: string): Promise<CandidateEvaluation | null> {
    const row = (await this.sql(`SELECT * FROM evaluation WHERE id = '${safeUuid(id)}'`))[0];
    return row ? CandidateEvaluation.parse(mapEvaluation(row)) : null;
  }

  async listCandidates(investigationId: string): Promise<ControllerCandidate[]> {
    const id = safeUuid(investigationId);
    const rows = await this.sql(`SELECT * FROM candidate WHERE investigation_id = '${id}'`);
    return Promise.all(rows.map(async (row) => {
      const candidate = await this.getCandidate(String(row.id));
      if (!candidate) throw new SpacetimeUnavailable();
      return candidate;
    }));
  }

  async listEvaluations(investigationId: string): Promise<CandidateEvaluation[]> {
    const rows = await this.sql(`SELECT * FROM evaluation WHERE investigation_id = '${safeUuid(investigationId)}'`);
    return rows.map((row) => CandidateEvaluation.parse(mapEvaluation(row)));
  }

  async listReviews(investigationId: string): Promise<HumanReview[]> {
    const rows = await this.sql(`SELECT * FROM human_review WHERE investigation_id = '${safeUuid(investigationId)}'`);
    return rows.map((row) => HumanReview.parse(mapReview(row)));
  }

  async getReview(id: string): Promise<HumanReview | null> {
    const row = (await this.sql(`SELECT * FROM human_review WHERE id = '${safeUuid(id)}'`))[0];
    return row ? HumanReview.parse(mapReview(row)) : null;
  }

  async findingsCount(investigationId: string): Promise<number> {
    return (await this.sql(`SELECT * FROM finding WHERE investigation_id = '${safeUuid(investigationId)}'`)).length;
  }

  async isTombstoned(targetKind: string, targetId: string): Promise<boolean> {
    if (NON_TOMBSTONE_KINDS.has(targetKind)) {
      safeUuid(targetId);
      return false;
    }
    if (!TOMBSTONE_KINDS.has(targetKind)) throw new SpacetimeRejected("invalid_tombstone");
    const id = safeUuid(targetId);
    const rows = await this.sql(`SELECT * FROM tombstone WHERE key = '${targetKind}:${id}'`);
    return rows.length > 0;
  }

  async ensureBridge(): Promise<void> {
    const key = `${this.uri}/${this.database}`;
    const token = this.env.SPACETIMEDB_BRIDGE_TOKEN || bridgeTokens.get(key);
    if (!token) {
      let identity: unknown;
      try {
        identity = await this.request("/v1/identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }, false);
      } catch {
        throw new SpacetimeUnavailable();
      }
      const candidate = identity && typeof identity === "object"
        ? (identity as Record<string, unknown>).token
        : undefined;
      if (typeof candidate !== "string" || !candidate) throw new SpacetimeUnavailable();
      bridgeTokens.set(key, candidate);
      await this.registerBridge(key, candidate);
      return;
    }
    await this.registerBridge(key, token);
  }

  private async registerBridge(key: string, token: string): Promise<void> {
    const existing = bridgeRegistrations.get(key);
    if (existing) return existing;
    const registration = this.request(
      `/v1/database/${encodeURIComponent(this.database)}/call/register_bridge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ secret: this.env.FORKSAFE_BRIDGE_SECRET ?? "" }),
      },
      true,
    ).then(() => undefined);
    bridgeRegistrations.set(key, registration);
    try {
      await registration;
    } catch (error) {
      bridgeRegistrations.delete(key);
      throw error;
    }
  }

  private async request(path: string, init: RequestInit, authenticated: boolean): Promise<unknown> {
    if (authenticated && !path.endsWith("/call/register_bridge")) await this.ensureBridge();
    const key = `${this.uri}/${this.database}`;
    const token = this.env.SPACETIMEDB_BRIDGE_TOKEN || bridgeTokens.get(key);
    const headers = new Headers(init.headers);
    if (authenticated && token) headers.set("Authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.uri}${path}`, { ...init, headers });
    } catch {
      throw new SpacetimeUnavailable();
    }
    const text = await response.text().catch(() => "");
    let value: unknown;
    try {
      value = text ? JSON.parse(text) as unknown : null;
    } catch {
      value = null;
    }
    if (!response.ok) {
      const reducerCode = extractCode(value) ?? extractCode(text);
      const code = reducerCode ?? `http_${response.status}`;
      if (!reducerCode && (response.status === 429 || response.status >= 500)) throw new SpacetimeUnavailable();
      throw new SpacetimeRejected(code);
    }
    return value;
  }
}

export const getSpacetimeClient = () => new SpacetimeClient();

export async function getFinding(id: string, client = getSpacetimeClient()) { return client.getFinding(id); }
export async function getExperiment(id: string, client = getSpacetimeClient()) { return client.getExperiment(id); }
export async function getCandidate(id: string, client = getSpacetimeClient()) { return client.getCandidate(id); }
export async function getEvaluation(id: string, client = getSpacetimeClient()) { return client.getEvaluation(id); }
export async function listCandidates(investigationId: string, client = getSpacetimeClient()) { return client.listCandidates(investigationId); }
export async function listEvaluations(investigationId: string, client = getSpacetimeClient()) { return client.listEvaluations(investigationId); }
export async function listReviews(investigationId: string, client = getSpacetimeClient()) { return client.listReviews(investigationId); }
export async function getReview(id: string, client = getSpacetimeClient()) { return client.getReview(id); }
export async function findingsCount(investigationId: string, client = getSpacetimeClient()) { return client.findingsCount(investigationId); }
export async function isTombstoned(targetKind: string, targetId: string, client = getSpacetimeClient()) { return client.isTombstoned(targetKind, targetId); }

export function decodeSqlResponse(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new SpacetimeUnavailable();
  const output: Row[] = [];
  for (const result of value) {
    if (!result || typeof result !== "object") continue;
    const table = result as Record<string, unknown>;
    const schema = table.schema as { elements?: Array<{ name?: unknown; type?: unknown; algebraic_type?: unknown }> } | undefined;
    const columns = schema?.elements?.map((column) => ({
      name: camelCase(decodeSats(column.name)),
      type: column.algebraic_type ?? column.type,
    })).filter((column): column is { name: string; type: unknown } => typeof column.name === "string") ?? [];
    const rows = Array.isArray(table.rows) ? table.rows : [];
    for (const row of rows) {
      if (Array.isArray(row)) {
        if (columns.length !== row.length) throw new SpacetimeUnavailable();
        output.push(Object.fromEntries(columns.map((column, index) => [
          column.name,
          decodeTyped(row[index], column.type),
        ])));
      } else if (row && typeof row === "object") {
        const columnTypes = new Map(columns.map((column) => [column.name, column.type]));
        output.push(Object.fromEntries(Object.entries(row).map(([key, item]) => {
          const name = camelCase(key);
          return [name, decodeTyped(item, columnTypes.get(name))];
        })));
      } else {
        throw new SpacetimeUnavailable();
      }
    }
  }
  return output;
}

type AlgebraicElement = { name?: unknown; algebraic_type?: unknown };

/** Decodes one SATS JSON value using the column's algebraic type. Maincloud's
 *  SQL endpoint encodes options as `[0, value]` / `[1, []]` and product values
 *  positionally, so the schema is required to recover field names. */
export function decodeTyped(value: unknown, type: unknown): unknown {
  if (!type || typeof type !== "object") return decodeSats(value);
  const node = type as Record<string, unknown>;
  if ("Sum" in node) return decodeSum(value, node.Sum as { variants?: AlgebraicElement[] });
  if ("Product" in node) return decodeProduct(value, node.Product as { elements?: AlgebraicElement[] });
  if ("Array" in node) {
    if (!Array.isArray(value)) throw new SpacetimeUnavailable();
    return value.map((item) => decodeTyped(item, node.Array));
  }
  if ("I64" in node || "U64" in node || "I128" in node || "U128" in node) return decodeSats(value, true);
  return decodeSats(value);
}

function decodeSum(value: unknown, sum: { variants?: AlgebraicElement[] }): unknown {
  const variants = sum.variants ?? [];
  const names = variants.map((variant) => decodeSats(variant.name));
  const isOption = names.length === 2 && names[0] === "some" && names[1] === "none";
  let tag: number;
  let payload: unknown;
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number") {
    [tag, payload] = value as [number, unknown];
  } else if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1) {
    const [key, item] = Object.entries(value)[0]!;
    tag = names.indexOf(key);
    if (tag < 0 && /^\d+$/.test(key)) tag = Number(key);
    payload = item;
  } else if (isOption && (value === null || value === undefined)) {
    return undefined;
  } else {
    throw new SpacetimeUnavailable();
  }
  const variant = variants[tag];
  if (!variant) throw new SpacetimeUnavailable();
  if (isOption) return tag === 0 ? decodeTyped(payload, variant.algebraic_type) : undefined;
  const name = names[tag];
  const decoded = decodeTyped(payload, variant.algebraic_type);
  const unit = decoded === undefined || (Array.isArray(decoded) && decoded.length === 0)
    || (decoded && typeof decoded === "object" && Object.keys(decoded).length === 0);
  return unit ? name : { [String(name)]: decoded };
}

function decodeProduct(value: unknown, product: { elements?: AlgebraicElement[] }): unknown {
  const elements = product.elements ?? [];
  if (Array.isArray(value)) {
    if (value.length !== elements.length) throw new SpacetimeUnavailable();
    return Object.fromEntries(elements.map((element, index) => [
      camelCase(decodeSats(element.name) ?? String(index)),
      decodeTyped(value[index], element.algebraic_type),
    ]));
  }
  if (!value || typeof value !== "object") throw new SpacetimeUnavailable();
  const types = new Map(elements.map((element) => [camelCase(decodeSats(element.name)), element.algebraic_type]));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const name = camelCase(key);
    return [name, decodeTyped(item, types.get(name))];
  }));
}

function decodeSats(value: unknown, i64 = false): unknown {
  if (i64) {
    const unwrapped = value && typeof value === "object" && "some" in value
      ? (value as { some: unknown }).some
      : value;
    if (unwrapped === null || unwrapped === undefined || typeof unwrapped === "object" && "none" in unwrapped) return undefined;
    const parsed = typeof unwrapped === "bigint" ? Number(unwrapped) : Number(unwrapped);
    if (!Number.isSafeInteger(parsed)) throw new SpacetimeUnavailable();
    return parsed;
  }
  if (Array.isArray(value)) return value.map((item) => decodeSats(item));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && "none" in object) return undefined;
  if (Object.keys(object).length === 1 && "some" in object) return decodeSats(object.some);
  if (Object.keys(object).length === 1 && "value" in object) return decodeSats(object.value);
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, decodeSats(item)]));
}

function isI64(type: unknown): boolean {
  return (JSON.stringify(type) ?? "").toLowerCase().includes("i64");
}

function camelCase(value: string): string;
function camelCase(value: unknown): unknown;
function camelCase(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase()) : value;
}

function mapExperiment(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    investigationId: row.investigationId,
    ...optionalField(row, "environmentId"),
    ...optionalField(row, "candidateId"),
    attemptId: row.attemptId,
    epoch: numeric(row.epoch),
    simCase: row.simCase,
    status: row.status,
    failureKinds: row.failureKinds,
    completed: row.completed,
    ...optionalField(row, "completionTimeSec"),
    changedFunctions: row.changedFunctions,
    ...optionalField(row, "traceArtifactId"),
    ...optionalField(row, "replayArtifactId"),
    engineVersion: row.engineVersion,
    assetsSha256: row.assetsSha256,
    controllerSha256: row.controllerSha256,
    startedAtMs: numeric(row.startedAtMs),
    ...optionalNumericField(row, "finishedAtMs"),
  };
}

function mapEvaluation(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    candidateId: row.candidateId,
    investigationId: row.investigationId,
    evaluatorAttemptId: row.evaluatorAttemptId,
    suite: row.suite,
    cases: row.cases,
    allRequiredPassed: row.allRequiredPassed,
    ...optionalField(row, "medianCompletionTimeSec"),
    status: row.status,
    ...optionalField(row, "reportArtifactId"),
    createdAtMs: numeric(row.createdAtMs),
  };
}

function mapReview(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    investigationId: row.investigationId,
    candidateId: row.candidateId,
    evaluationId: row.evaluationId,
    controllerSha256: row.controllerSha256,
    decision: row.decision,
    reviewerIdentity: row.reviewerIdentity,
    ...optionalField(row, "notes"),
    ...optionalField(row, "jiraIssueKey"),
    createdAtMs: numeric(row.createdAtMs),
  };
}

function safeUuid(value: string): string {
  if (!UUID.test(value)) throw new SpacetimeRejected("invalid_id");
  return value;
}

function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint" || typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new SpacetimeUnavailable();
}

function optionalNumericField(row: Row, name: string): Record<string, unknown> {
  return row[name] === undefined ? {} : { [name]: numeric(row[name]) };
}

function optionalField(row: Row, name: string): Record<string, unknown> {
  return row[name] === undefined ? {} : { [name]: row[name] };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new SpacetimeUnavailable();
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Row;
  } catch { /* handled below */ }
  throw new SpacetimeUnavailable();
}

function extractCode(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.match(/^\s*([a-z][a-z0-9_]*):/i)?.[1]?.toLowerCase();
  }
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const nested = object.error && typeof object.error === "object"
    ? object.error as Record<string, unknown>
    : object;
  const raw = nested.code ?? nested.message ?? nested.error;
  if (typeof raw !== "string") return undefined;
  const matches = [...raw.matchAll(/(?:^|\b)([a-z][a-z0-9_]*):/gi)];
  return matches.at(-1)?.[1]?.toLowerCase();
}

function runtimeEnvironment(): Environment {
  return (globalThis as typeof globalThis & { process?: { env?: Environment } }).process?.env ?? {};
}
