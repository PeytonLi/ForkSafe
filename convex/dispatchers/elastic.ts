"use node";

import {
  CandidateEvaluation,
  ControllerCandidate,
  ExperimentResult,
  Finding,
} from "@forksafe/contracts";
import { v } from "convex/values";
import { createElasticClient, elasticReadiness, resolveConfig } from "../../packages/integrations/elastic/src/config.js";
import { ElasticIndexer } from "../../packages/integrations/elastic/src/indexer.js";
import { internal } from "../_generated/api.js";
import { internalAction } from "../_generated/server.js";
import { SpacetimeClient, SpacetimeRejected } from "./spacetime.js";
import { ZodError } from "zod";

type RecordKind = "finding" | "experiment_result" | "candidate" | "evaluation";
type RecordValue = Finding | ExperimentResult | ControllerCandidate | CandidateEvaluation;
type DeliveryMode = "live" | "local" | "blocked" | "not_implemented";
type DeliveryResult = { delivered: boolean; mode: DeliveryMode; reason?: string };
type IndexResult = { result: string; errorType?: "permanent" | "transient" | "auth"; errorCode?: string; status?: number };

interface DeliveryDeps {
  indexer: Pick<ElasticIndexer, "index" | "deleteBySource">;
  spacetime: Pick<SpacetimeClient, "getFinding" | "getExperiment" | "getCandidate" | "getEvaluation" | "isTombstoned" | "callReducer">;
  mode: DeliveryMode;
  deadLetter: (key: string, code: string) => Promise<boolean>;
  wait?: (ms: number) => Promise<void>;
  random?: () => number;
}

const schemas = {
  finding: Finding,
  experiment_result: ExperimentResult,
  candidate: ControllerCandidate,
  evaluation: CandidateEvaluation,
} as const;

export async function deliverElasticPayload(payload: unknown, deps: DeliveryDeps): Promise<DeliveryResult> {
  let operation: { kind: RecordKind; record: RecordValue; key: string; sourceKind?: string; sourceId?: string };
  try {
    operation = await resolvePayload(payload, deps.spacetime);
  } catch (error) {
    const key = elasticIdempotencyKey(payload);
    if (error instanceof SpacetimeRejected) {
      if (key) await deps.deadLetter(key, safeCode(error.code)).catch(() => false);
      return { delivered: false, mode: deps.mode, reason: `permanent:${error.code}` };
    }
    if (error instanceof ZodError || error instanceof TypeError) {
      if (key) await deps.deadLetter(key, "elastic_invalid_payload").catch(() => false);
      return { delivered: false, mode: deps.mode, reason: "permanent:elastic_invalid_payload" };
    }
    return { delivered: false, mode: deps.mode, reason: "spacetime_unavailable" };
  }
  if ("operation" in (payload as object) && (payload as { operation?: unknown }).operation === "delete") {
    const tombstone = payload as { targetKind: string; targetId: string };
    try {
      await deps.indexer.deleteBySource({ sourceId: tombstone.targetId });
    } catch {
      return { delivered: false, mode: deps.mode, reason: "elastic_delete_failed" };
    }
    await bestEffortMarkDelivered(deps.spacetime, operation.key);
    return { delivered: true, mode: deps.mode };
  }

  const tombstoneKind = operation.sourceKind ?? operation.kind;
  const sourceId = operation.sourceId ?? operation.record.id;
  try {
    if (await deps.spacetime.isTombstoned(tombstoneKind, sourceId)) {
      await deps.indexer.deleteBySource({ sourceId });
      await bestEffortMarkDelivered(deps.spacetime, operation.key);
      return { delivered: true, mode: deps.mode };
    }
  } catch {
    return { delivered: false, mode: deps.mode, reason: "spacetime_unavailable" };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let results: IndexResult[];
    try {
      results = await deps.indexer.index(operation.record, { idempotencyKey: operation.key });
    } catch {
      results = [{ result: "error", errorType: "transient" }];
    }
    if (results.every((result) => result.result !== "error")) {
      await bestEffortMarkDelivered(deps.spacetime, operation.key);
      return { delivered: true, mode: deps.mode };
    }
    const permanent = results.find((result) => result.result === "error" && result.errorType === "permanent");
    if (permanent) {
      const code = safeCode(permanent.errorCode ?? `http_${permanent.status ?? "unknown"}`);
      await deps.deadLetter(operation.key, code).catch(() => false);
      return {
        delivered: false,
        mode: deps.mode,
        reason: `permanent:${code}`,
      };
    }
    if (attempt < 2) {
      const delay = 100 * 2 ** attempt * (0.5 + (deps.random ?? Math.random)());
      await (deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
    }
  }
  return { delivered: false, mode: deps.mode, reason: "elastic_transient" };
}

async function resolvePayload(
  payload: unknown,
  spacetime: DeliveryDeps["spacetime"],
): Promise<{ kind: RecordKind; record: RecordValue; key: string; sourceKind?: string; sourceId?: string }> {
  if (!payload || typeof payload !== "object") throw new Error("invalid_payload");
  const value = payload as Record<string, unknown>;
  if (value.operation === "delete") {
    const targetKind = typeof value.targetKind === "string" ? value.targetKind : "";
    const targetId = typeof value.targetId === "string" ? value.targetId : "";
    if (!targetKind || !targetId) throw new Error("invalid_tombstone");
    return { kind: "finding", record: {} as Finding, key: `tombstone:${targetKind}:${targetId}:elastic_index`, sourceKind: targetKind, sourceId: targetId };
  }

  const kind = parseKind(value.kind);
  const id = typeof value.id === "string" ? value.id : undefined;
  const wrappedRecord = value.record;
  if (kind && id && wrappedRecord === undefined) {
    const key = `${kind}:${id}:elastic_index`;
    if (await spacetime.isTombstoned(kind, id)) {
      return { kind, record: {} as RecordValue, key, sourceKind: kind, sourceId: id };
    }
    const record = await getByKind(spacetime, kind, id);
    if (!record) throw new Error("canonical_record_missing");
    return { kind, record, key, sourceKind: kind, sourceId: id };
  }

  if (kind && wrappedRecord !== undefined) {
    const record = schemas[kind].parse(wrappedRecord) as RecordValue;
    return { kind, record, key: `${kind}:${record.id}:elastic_index`, sourceKind: kind, sourceId: record.id };
  }

  for (const candidateKind of Object.keys(schemas) as RecordKind[]) {
    const parsed = schemas[candidateKind].safeParse(value);
    if (parsed.success) {
      return {
        kind: candidateKind,
        record: parsed.data as RecordValue,
        key: `${candidateKind}:${parsed.data.id}:elastic_index`,
        sourceKind: candidateKind,
        sourceId: parsed.data.id,
      };
    }
  }
  throw new Error("unsupported_payload");
}

function parseKind(value: unknown): RecordKind | undefined {
  return value === "finding" || value === "experiment_result" || value === "candidate" || value === "evaluation"
    ? value
    : undefined;
}

async function getByKind(spacetime: DeliveryDeps["spacetime"], kind: RecordKind, id: string): Promise<RecordValue | null> {
  switch (kind) {
    case "finding": return spacetime.getFinding(id);
    case "experiment_result": return spacetime.getExperiment(id);
    case "candidate": return spacetime.getCandidate(id);
    case "evaluation": return spacetime.getEvaluation(id);
  }
}

async function bestEffortMarkDelivered(spacetime: DeliveryDeps["spacetime"], idempotencyKey: string) {
  try {
    await spacetime.callReducer("outbox_mark_delivered", { idempotencyKey });
  } catch {
    // Convex outbox delivery remains authoritative when this mirror is unavailable.
  }
}

function safeCode(value: string): string {
  return /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : "elastic_permanent_error";
}

export function elasticIdempotencyKey(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  if (value.operation === "delete" && typeof value.targetKind === "string" && typeof value.targetId === "string") {
    return `tombstone:${value.targetKind}:${value.targetId}:elastic_index`;
  }
  if (parseKind(value.kind) && typeof value.id === "string") return `${value.kind}:${value.id}:elastic_index`;
  if (parseKind(value.kind) && value.record && typeof value.record === "object" && typeof (value.record as { id?: unknown }).id === "string") {
    return `${value.kind}:${(value.record as { id: string }).id}:elastic_index`;
  }
  return undefined;
}

export const dispatch = internalAction({
  args: { payload: v.any() },
  handler: async (ctx, args): Promise<DeliveryResult> => {
    const env = resolveConfig();
    const mode = elasticReadiness(env, Date.now()).mode;
    if (mode !== "live" && mode !== "local") return { delivered: false, mode: "blocked", reason: "elastic_not_configured" };
    const client = createElasticClient(env);
    if (!client) return { delivered: false, mode: "blocked", reason: "elastic_not_configured" };
    const indexer = new ElasticIndexer(mode, client);
    const spacetime = new SpacetimeClient();
    try {
      return await deliverElasticPayload(args.payload, {
        mode,
        indexer,
        spacetime,
        deadLetter: async (key, errorCode) => {
          const result = await ctx.runMutation(internal.dispatchers.outbox.deadLetter, { idempotencyKey: key, errorCode });
          return result.updated;
        },
      });
    } finally {
      await client.close();
    }
  },
});
