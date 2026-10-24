import type { estypes } from "@elastic/elasticsearch";

export const INDEX_PREFIX = "forksafe-";
export const INDICES = {
  finding: "forksafe-findings",
  evidence: "forksafe-evidence",
  experiment_result: "forksafe-experiments",
  candidate: "forksafe-candidates",
  evaluation: "forksafe-evaluations",
} as const;
const keywords = ["id", "docType", "kind", "investigationId", "environmentId", "sessionId", "candidateId", "experimentId", "artifactId", "findingId", "failureKinds", "status", "suite", "caseId", "idempotencyKey", "contentHash", "sourceVersion", "sourceSystem", "sourceEntity", "sourceId", "controllerSha256", "changedFunctions"];
export const mapping: estypes.MappingTypeMapping = {
  dynamic: "strict",
  properties: {
    ...Object.fromEntries(keywords.map(key => [key, { type: "keyword" }])),
    createdAt: { type: "date", format: "epoch_millis" },
    indexedAt: { type: "date", format: "epoch_millis" },
    text: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
  },
};
export const mappings = Object.fromEntries(Object.values(INDICES).map(index => [index, mapping]));
export interface IndexAdmin {
  indices: {
    exists(request: estypes.IndicesExistsRequest): Promise<boolean>;
    create(request: estypes.IndicesCreateRequest): Promise<unknown>;
  };
}
export async function bootstrapIndices(client: IndexAdmin) {
  for (const index of Object.values(INDICES)) {
    if (await client.indices.exists({ index })) continue;
    try { await client.indices.create({ index, mappings: mapping }); }
    catch (error) {
      if ((error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type !== "resource_already_exists_exception") throw new Error("Elastic index bootstrap failed");
    }
  }
}

/** Dispatcher-recorded per-document indexing failures; never searched as evidence. */
export const INDEX_ERRORS_INDEX = "forksafe-index-errors";
export const indexErrorMapping: estypes.MappingTypeMapping = {
  dynamic: "strict",
  properties: {
    ...Object.fromEntries(["id", "index", "docId", "idempotencyKey", "errorType", "errorCode", "investigationId"].map(key => [key, { type: "keyword" }])),
    status: { type: "integer" },
    attempt: { type: "integer" },
    recordedAt: { type: "date", format: "epoch_millis" },
  },
};
export async function bootstrapErrorIndex(client: IndexAdmin) {
  if (await client.indices.exists({ index: INDEX_ERRORS_INDEX })) return;
  try { await client.indices.create({ index: INDEX_ERRORS_INDEX, mappings: indexErrorMapping }); }
  catch (error) {
    if ((error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type !== "resource_already_exists_exception") throw new Error("Elastic index bootstrap failed");
  }
}
