import { SenderError, t, type InferSchema, type ReducerCtx } from "spacetimedb/server";
import {
  ARTIFACT_KINDS,
  ARTIFACT_STORAGES,
  EVALUATION_STATUSES,
  EXPERIMENT_STATUSES,
  FAILURE_KINDS,
  OUTBOX_DESTINATIONS,
  REVIEW_DECISIONS,
  TOMBSTONE_TARGET_KINDS,
  checkArtifactScope,
  checkExpectedHead,
  checkScope,
  experimentIdentity,
  findingUseKey,
  isSha256,
  isUuid,
  planBaselineRegister,
  planBridgeRotation,
  planExperimentCommit,
  planFindingUse,
  planEvaluationWrite,
  planGrantInstall,
  planLeaseAcquire,
  planLeaseRenew,
  planOutboxEnqueue,
  planOutboxFailure,
  secretsMatch,
  validateFindingInput,
  validateGrantUse,
  type BaselineInput,
  type BaselineExisting,
  type ExperimentIdentityRow,
  type GrantLike,
  type GrantRef,
  type OutboxInput,
} from "./logic/index.js";
import databaseSchema, {
  artifactRef,
  attemptHeartbeat,
  baseline,
  baselineRequirement,
  bridgeIdentity,
  candidate,
  controllerRevision,
  evaluation,
  evidence,
  executionGrant,
  experiment,
  experimentIdentity as experimentIdentityTable,
  finding,
  findingLink,
  findingUse,
  humanReview,
  jobFence,
  outboxEntry,
  revisionHead,
  revisionLease,
  tombstone,
} from "./schema.js";

export { default } from "./schema.js";

type Ctx = ReducerCtx<InferSchema<typeof databaseSchema>>;
type GrantRow = ReturnType<Ctx["db"]["executionGrant"]["id"]["find"]> extends infer Row
  ? Exclude<Row, null>
  : never;

const grantRef = t.object("GrantRef", {
  grantId: t.string(),
  attemptId: t.string(),
  epoch: t.u32(),
});
const evidenceInput = t.object("EvidenceInput", {
  kind: t.string(),
  artifactId: t.option(t.string()),
  experimentId: t.option(t.string()),
  locatorJson: t.string(),
  excerpt: t.option(t.string()),
});
const findingLinkInput = t.object("FindingLinkInput", {
  toFindingId: t.string(),
  relation: t.string(),
});
const simCaseInput = t.object("SimCaseInput", {
  caseId: t.string(),
  suite: t.string(),
  seed: t.u32(),
  sceneOverridesJson: t.string(),
  description: t.option(t.string()),
});
const caseEvaluationInput = t.object("CaseEvaluationInput", {
  caseId: t.string(),
  status: t.string(),
  experimentId: t.option(t.string()),
  completionTimeSec: t.option(t.f64()),
  failureKinds: t.array(t.string()),
});
const requirementRuleInput = t.object("RequirementRuleInput", {
  ruleId: t.string(),
  confluencePageId: t.string(),
  confluencePageRevision: t.u32(),
  title: t.string(),
  enforcement: t.string(),
  ruleJson: t.string(),
});

function nowMs(ctx: Ctx): number {
  return Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n);
}

function reject(code: string, message: string): never {
  throw new SenderError(`${code}: ${message}`);
}

function enforce<T extends { ok: boolean; code?: string; message?: string }>(
  result: T,
): asserts result is T & { ok: true } {
  if (!result.ok) reject(result.code ?? "invalid_request", result.message ?? "Request rejected");
}

function validIds(...ids: Array<string | undefined>): void {
  if (ids.some((id) => id !== undefined && !isUuid(id))) {
    reject("invalid_id", "Application ids must be UUIDs");
  }
}

function requireBridge(ctx: Ctx): void {
  if (!ctx.db.bridgeIdentity.identity.find(ctx.sender)) {
    reject("bridge_required", "Bridge identity is not registered");
  }
}

function requireBridgeSecret(ctx: Ctx, secret: string): void {
  const configured = ctx.env.FORKSAFE_BRIDGE_SECRET;
  if (configured === undefined || configured.length === 0) {
    reject("bridge_secret_not_configured", "bridge secret not configured");
  }
  if (!secretsMatch(configured, secret)) {
    reject("bridge_secret_mismatch", "Bridge secret does not match");
  }
}

function upsertBridgeIdentity(ctx: Ctx): void {
  const existing = ctx.db.bridgeIdentity.identity.find(ctx.sender);
  const row = {
    identity: ctx.sender,
    role: "convex",
    registeredAtMs: BigInt(nowMs(ctx)),
  };
  if (existing) ctx.db.bridgeIdentity.identity.update({ ...existing, ...row });
  else ctx.db.bridgeIdentity.insert(row);
}

function grantLike(row: GrantRow): GrantLike {
  return {
    id: row.id,
    jobId: row.jobId,
    attemptId: row.attemptId,
    epoch: row.epoch,
    investigationId: row.investigationId,
    environmentId: row.environmentId,
    operations: row.operations,
    artifactPrefixes: row.artifactPrefixes,
    maxBytes: Number(row.maxBytes),
    bytesUsed: Number(row.bytesUsed),
    expiresAtMs: Number(row.expiresAtMs),
    revokedAtMs: row.revokedAtMs === undefined ? undefined : Number(row.revokedAtMs),
    revokeReason: row.revokeReason,
    holder: row.holder?.toHexString(),
  };
}

function requireGrant(ctx: Ctx, ref: GrantRef, operation: string): GrantRow {
  const grant = ctx.db.executionGrant.id.find(ref.grantId);
  const fence = grant ? ctx.db.jobFence.jobId.find(grant.jobId) : undefined;
  const result = validateGrantUse(
    grant ? grantLike(grant) : undefined,
    fence
      ? { jobId: fence.jobId, epoch: fence.epoch, grantId: fence.grantId }
      : undefined,
    ref,
    operation,
    nowMs(ctx),
    ctx.sender.toHexString(),
  );
  enforce(result);
  if (result.bindHolder && grant) {
    ctx.db.executionGrant.id.update({ ...grant, holder: ctx.sender });
  }
  return grant as GrantRow;
}

function requireScope(
  grant: GrantRow,
  scope: { investigationId?: string; environmentId?: string },
): void {
  const result = checkScope(grantLike(grant), scope);
  enforce(result);
}

function upsertOutbox(ctx: Ctx, input: OutboxInput): void {
  const existing = ctx.db.outboxEntry.idempotencyKey.find(input.idempotencyKey);
  const existingForLogic = existing
    ? {
        ...existing,
        createdAtMs: Number(existing.createdAtMs),
        deliveredAtMs:
          existing.deliveredAtMs === undefined ? undefined : Number(existing.deliveredAtMs),
      }
    : undefined;
  const result = planOutboxEnqueue(existingForLogic, input);
  enforce(result);
  if (result.noOp) return;
  ctx.db.outboxEntry.insert({
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    destination: input.destination,
    status: "pending",
    operationId: input.operationId,
    payloadJson: input.payloadJson,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    attempts: 0,
    lastError: undefined,
    createdAtMs: BigInt(nowMs(ctx)),
    deliveredAtMs: undefined,
  });
}

function enqueueFor(
  ctx: Ctx,
  destination: string,
  idempotencyKey: string,
  payload: Record<string, string>,
  sourceKind: string,
  sourceId: string,
): void {
  upsertOutbox(ctx, {
    id: ctx.newUuidV4().toString(),
    destination,
    idempotencyKey,
    operationId: ctx.newUuidV4().toString(),
    payloadJson: JSON.stringify(payload),
    sourceKind,
    sourceId,
  });
}

function parseObjectJson(value: string, code: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return reject(code, "JSON value is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reject(code, "JSON value must be an object");
  }
  return parsed as Record<string, unknown>;
}

function sameJson(left: unknown, right: unknown): boolean {
  const stringify = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? `${item.toString()}n` : item,
    );
  return stringify(left) === stringify(right);
}

function sameExperiment(existing: unknown, input: unknown): boolean {
  const left = existing as Record<string, unknown>;
  const right = input as Record<string, unknown>;
  return (
    [
      "id",
      "attemptId",
      "epoch",
      "grantId",
      "investigationId",
      "environmentId",
      "candidateId",
      "simCase",
      "status",
      "failureKinds",
      "completed",
      "completionTimeSec",
      "changedFunctions",
      "traceArtifactId",
      "replayArtifactId",
      "engineVersion",
      "assetsSha256",
      "controllerSha256",
      "startedAtMs",
      "finishedAtMs",
    ].every((key) => sameJson(left[key], right[key]))
  );
}

function resolveExperiment(ctx: Ctx, id: string) {
  const direct = ctx.db.experiment.id.find(id);
  if (direct) return direct;
  const identity = ctx.db.experimentIdentity.experimentId.find(id);
  return identity
    ? ctx.db.experiment.id.find(identity.canonicalExperimentId)
    : undefined;
}

function experimentRowIsTombstoned(ctx: Ctx, row: { traceArtifactId?: string; replayArtifactId?: string }): boolean {
  return [row.traceArtifactId, row.replayArtifactId].some(
    (artifactId) => artifactId !== undefined && ctx.db.tombstone.key.find(`artifact:${artifactId}`) !== null,
  );
}

function rejectTombstonedExperimentArtifacts(ctx: Ctx, row: {
  candidateId?: string;
  traceArtifactId?: string;
  replayArtifactId?: string;
}): void {
  if (
    row.traceArtifactId !== undefined && ctx.db.tombstone.key.find(`artifact:${row.traceArtifactId}`) ||
    row.replayArtifactId !== undefined && ctx.db.tombstone.key.find(`artifact:${row.replayArtifactId}`)
  ) {
    reject("artifact_tombstoned", "Experiment references a tombstoned trace or replay artifact");
  }
  if (row.candidateId !== undefined && ctx.db.tombstone.key.find(`candidate:${row.candidateId}`)) {
    reject("candidate_tombstoned", "Experiment candidate is tombstoned");
  }
}

interface ExperimentReducerInput {
  grant: GrantRef;
  id: string;
  investigationId: string;
  environmentId?: string;
  candidateId?: string;
  simCase: {
    caseId: string;
    suite: string;
    seed: number;
    sceneOverridesJson: string;
    description?: string;
  };
  status: string;
  failureKinds: string[];
  completed: boolean;
  completionTimeSec?: number;
  changedFunctions: string[];
  traceArtifactId?: string;
  replayArtifactId?: string;
  engineVersion: string;
  assetsSha256: string;
  controllerSha256: string;
  startedAtMs: bigint;
  finishedAtMs?: bigint;
}

function writeExperiment(
  ctx: Ctx,
  input: ExperimentReducerInput,
  replicationOf?: string,
  replicationReason?: string,
): void {
  const grant = requireGrant(ctx, input.grant, "record_experiment");
  requireScope(grant, {
    investigationId: input.investigationId,
    environmentId: input.environmentId,
  });
  validIds(
    input.id,
    input.investigationId,
    input.environmentId,
    input.candidateId,
    input.traceArtifactId,
    input.replayArtifactId,
    replicationOf,
  );
  if (!(EXPERIMENT_STATUSES as readonly string[]).includes(input.status)) {
    reject("invalid_experiment", "Experiment status is invalid");
  }
  if (input.failureKinds.some((kind) => !(FAILURE_KINDS as readonly string[]).includes(kind))) {
    reject("invalid_experiment", "Experiment failure kind is invalid");
  }
  if (!isSha256(input.assetsSha256) || !isSha256(input.controllerSha256)) {
    reject("invalid_id", "Experiment hashes must be lowercase SHA-256");
  }
  parseObjectJson(input.simCase.sceneOverridesJson, "invalid_experiment");
  if (input.candidateId && !ctx.db.candidate.id.find(input.candidateId)) {
    reject("candidate_missing", "Experiment candidate does not exist");
  }
  for (const artifactId of [input.traceArtifactId, input.replayArtifactId]) {
    if (artifactId && !ctx.db.artifactRef.id.find(artifactId)) {
      reject("artifact_missing", "Experiment artifact does not exist");
    }
  }

  const existing = ctx.db.experiment.id.find(input.id);
  const values = {
    ...input,
    attemptId: grant.attemptId,
    epoch: grant.epoch,
    grantId: grant.id,
  };
  if (existing) {
    if (sameExperiment(existing, values)) return;
    reject("duplicate_id", "Experiment id already exists with different fields");
  }
  const existingIdentity = ctx.db.experimentIdentity.experimentId.find(input.id);
  const identityHash = experimentIdentity({
    controllerSha256: input.controllerSha256,
    suite: input.simCase.suite,
    caseId: input.simCase.caseId,
    seed: input.simCase.seed,
    sceneOverridesJson: input.simCase.sceneOverridesJson,
    assetsSha256: input.assetsSha256,
    engineVersion: input.engineVersion,
  });
  const authorClass = grant.environmentId === undefined ? "evaluator" : "swarm";
  const replicationTargetRow = replicationOf === undefined
    ? undefined
    : ctx.db.experimentIdentity.experimentId.find(replicationOf);
  const replicationTarget: ExperimentIdentityRow | undefined = replicationTargetRow
    ? {
        experimentId: replicationTargetRow.experimentId,
        investigationId: replicationTargetRow.investigationId,
        identityHash: replicationTargetRow.identityHash,
        authorClass: replicationTargetRow.authorClass as "evaluator" | "swarm",
        role: replicationTargetRow.role as "canonical" | "duplicate" | "replication",
        canonicalExperimentId: replicationTargetRow.canonicalExperimentId,
        replicationOfExperimentId: replicationTargetRow.replicationOfExperimentId,
      }
    : undefined;
  const canonicalForScope = [...ctx.db.experimentIdentity.identityHash.filter(identityHash)]
    .find((row) =>
      row.investigationId === input.investigationId &&
      row.authorClass === authorClass &&
      row.role === "canonical",
    );
  const plan = planExperimentCommit({
    existingExperimentSameId: existing ? { identical: false } : undefined,
    existingIdentitySameId: existingIdentity
      ? { role: existingIdentity.role as "canonical" | "duplicate" | "replication", identityHash: existingIdentity.identityHash }
      : undefined,
    canonicalForScope: canonicalForScope
      ? {
          experimentId: canonicalForScope.experimentId,
          investigationId: canonicalForScope.investigationId,
          identityHash: canonicalForScope.identityHash,
          authorClass: canonicalForScope.authorClass as "evaluator" | "swarm",
          role: canonicalForScope.role as "canonical" | "duplicate" | "replication",
          canonicalExperimentId: canonicalForScope.canonicalExperimentId,
        }
      : undefined,
    replicationTarget,
    input: {
      id: input.id,
      investigationId: input.investigationId,
      authorClass,
      identityHash,
      ...(replicationOf === undefined ? {} : { replicationOf }),
      ...(replicationReason === undefined ? {} : { replicationReason }),
    },
  });
  enforce(plan);
  if (plan.action === "noop") return;

  rejectTombstonedExperimentArtifacts(ctx, input);
  if (plan.action === "alias_duplicate") {
    ctx.db.experimentIdentity.insert({
      experimentId: input.id,
      investigationId: input.investigationId,
      identityHash,
      authorClass,
      role: "duplicate",
      canonicalExperimentId: plan.canonicalExperimentId as string,
      replicationOfExperimentId: undefined,
      replicationReason: undefined,
      environmentId: input.environmentId,
      candidateId: input.candidateId,
      grantId: grant.id,
      createdAtMs: BigInt(nowMs(ctx)),
    });
    return;
  }

  ctx.db.experiment.insert({
    ...input,
    environmentId: input.environmentId,
    candidateId: input.candidateId,
    completionTimeSec: input.completionTimeSec ?? undefined,
    traceArtifactId: input.traceArtifactId ?? undefined,
    replayArtifactId: input.replayArtifactId ?? undefined,
    finishedAtMs: input.finishedAtMs ?? undefined,
    attemptId: grant.attemptId,
    epoch: grant.epoch,
    grantId: grant.id,
    simCase: {
      ...input.simCase,
      description: input.simCase.description ?? undefined,
    },
  });
  ctx.db.experimentIdentity.insert({
    experimentId: input.id,
    investigationId: input.investigationId,
    identityHash,
    authorClass,
    role: plan.action === "insert_replication" ? "replication" : "canonical",
    canonicalExperimentId: input.id,
    replicationOfExperimentId: replicationOf,
    replicationReason,
    environmentId: input.environmentId,
    candidateId: input.candidateId,
    grantId: grant.id,
    createdAtMs: BigInt(nowMs(ctx)),
  });
}

interface FindingUseReducerInput {
  id: string;
  findingId: string;
  experimentId?: string;
  candidateId?: string;
}

function writeFindingUse(ctx: Ctx, grant: GrantRow, input: FindingUseReducerInput): void {
  const findingRow = ctx.db.finding.id.find(input.findingId);
  const experimentRow = input.experimentId === undefined ? undefined : resolveExperiment(ctx, input.experimentId);
  const candidateRow = input.candidateId === undefined ? undefined : ctx.db.candidate.id.find(input.candidateId);
  const existingSameId = ctx.db.findingUse.id.find(input.id);
  const useKey = findingUseKey(input);
  const existingSameKey = ctx.db.findingUse.useKey.find(useKey);
  const crossEnvironment = findingRow !== null && findingRow.environmentId !== grant.environmentId;
  const expectedInvestigationId = findingRow?.investigationId;
  const identical =
    existingSameId !== null &&
    existingSameId.useKey === useKey &&
    existingSameId.findingId === input.findingId &&
    existingSameId.findingInvestigationId === expectedInvestigationId &&
    existingSameId.findingEnvironmentId === findingRow?.environmentId &&
    existingSameId.usedByEnvironmentId === grant.environmentId &&
    existingSameId.experimentId === input.experimentId &&
    existingSameId.candidateId === input.candidateId &&
    existingSameId.crossEnvironment === crossEnvironment &&
    existingSameId.grantId === grant.id &&
    existingSameId.attemptId === grant.attemptId &&
    existingSameId.epoch === grant.epoch;
  const result = planFindingUse({
    grant: grantLike(grant),
    finding: findingRow
      ? { investigationId: findingRow.investigationId, environmentId: findingRow.environmentId }
      : undefined,
    findingTombstoned: ctx.db.tombstone.key.find(`finding:${input.findingId}`) !== null,
    experiment: experimentRow
      ? { investigationId: experimentRow.investigationId, environmentId: experimentRow.environmentId }
      : undefined,
    candidate: candidateRow
      ? { investigationId: candidateRow.investigationId, environmentId: candidateRow.environmentId }
      : undefined,
    existingSameId: existingSameId ? { identical } : undefined,
    existingSameKey: existingSameKey !== null,
    input: {
      ...input,
      grantId: grant.id,
      attemptId: grant.attemptId,
      epoch: grant.epoch,
    },
  });
  enforce(result);
  if (result.noOp) return;
  if (candidateRow && ctx.db.tombstone.key.find(`candidate:${input.candidateId}`)) {
    reject("candidate_tombstoned", "Finding use candidate is tombstoned");
  }
  if (experimentRow && experimentRowIsTombstoned(ctx, experimentRow)) {
    reject("artifact_tombstoned", "Finding use experiment references a tombstoned artifact");
  }
  ctx.db.findingUse.insert({
    id: input.id,
    useKey,
    findingId: input.findingId,
    findingInvestigationId: findingRow?.investigationId as string,
    findingEnvironmentId: findingRow?.environmentId as string,
    usedByEnvironmentId: grant.environmentId as string,
    experimentId: input.experimentId,
    candidateId: input.candidateId,
    crossEnvironment: result.crossEnvironment,
    grantId: grant.id,
    attemptId: grant.attemptId,
    epoch: grant.epoch,
    createdAtMs: BigInt(nowMs(ctx)),
  });
}

export const registerBridge = databaseSchema.reducer(
  { secret: t.string() },
  (ctx, { secret }) => {
    requireBridgeSecret(ctx, secret);
    upsertBridgeIdentity(ctx);
  },
);

export const rotateBridgeIdentity = databaseSchema.reducer(
  { secret: t.string() },
  (ctx, { secret }) => {
    requireBridgeSecret(ctx, secret);
    const rows = [...ctx.db.bridgeIdentity.iter()];
    const { revokeHex } = planBridgeRotation(
      rows.map((row) => ({ identityHex: row.identity.toHexString(), role: row.role })),
      ctx.sender.toHexString(),
    );
    const revoke = new Set(revokeHex);
    for (const row of rows) {
      if (revoke.has(row.identity.toHexString())) ctx.db.bridgeIdentity.identity.delete(row.identity);
    }
    upsertBridgeIdentity(ctx);
  },
);

export const unregisterBridge = databaseSchema.reducer((ctx) => {
  ctx.db.bridgeIdentity.identity.delete(ctx.sender);
});

export const installGrant = databaseSchema.reducer(
  {
    id: t.string(),
    jobId: t.string(),
    attemptId: t.string(),
    epoch: t.u32(),
    investigationId: t.string(),
    environmentId: t.option(t.string()),
    operations: t.array(t.string()),
    artifactPrefixes: t.array(t.string()),
    maxBytes: t.u64(),
    expiresAtMs: t.i64(),
  },
  (ctx, input) => {
    requireBridge(ctx);
    const now = nowMs(ctx);
    const existing = ctx.db.executionGrant.id.find(input.id);
    const fence = ctx.db.jobFence.jobId.find(input.jobId);
    const existingForJob = [...ctx.db.executionGrant.jobId.filter(input.jobId)];
    const installInput = {
      ...input,
      environmentId: input.environmentId ?? undefined,
      maxBytes: Number(input.maxBytes),
      expiresAtMs: Number(input.expiresAtMs),
    };
    const result = planGrantInstall(
      existing ? grantLike(existing) : undefined,
      fence ? { jobId: fence.jobId, epoch: fence.epoch, grantId: fence.grantId } : undefined,
      installInput,
      now,
      existingForJob.map(grantLike),
    );
    enforce(result);
    if (result.noOp) return;

    const installedAtMs = BigInt(now);
    ctx.db.executionGrant.insert({
      ...input,
      environmentId: input.environmentId ?? undefined,
      bytesUsed: 0n,
      revokedAtMs: undefined,
      revokeReason: undefined,
      holder: undefined,
      installedAtMs,
    });
    const fenceRow = {
      jobId: input.jobId,
      epoch: input.epoch,
      grantId: input.id,
      updatedAtMs: installedAtMs,
    };
    if (fence) ctx.db.jobFence.jobId.update(fenceRow);
    else ctx.db.jobFence.insert(fenceRow);

    for (const grantId of result.supersededIds) {
      const prior = ctx.db.executionGrant.id.find(grantId);
      if (prior) {
        ctx.db.executionGrant.id.update({
          ...prior,
          revokedAtMs: installedAtMs,
          revokeReason: "superseded",
        });
      }
    }
  },
);

export const revokeGrant = databaseSchema.reducer(
  { grantId: t.string(), reason: t.string() },
  (ctx, { grantId }) => {
    requireBridge(ctx);
    const grant = ctx.db.executionGrant.id.find(grantId);
    if (!grant || grant.revokedAtMs !== undefined) return;
    ctx.db.executionGrant.id.update({
      ...grant,
      revokedAtMs: BigInt(nowMs(ctx)),
      revokeReason: "revoked",
    });
    for (const lease of ctx.db.revisionLease.iter()) {
      if (lease.grantId === grantId) ctx.db.revisionLease.environmentId.delete(lease.environmentId);
    }
  },
);

export const registerBaseline = databaseSchema.reducer(
  {
    id: t.string(),
    simCase: simCaseInput,
    sceneSha256: t.string(),
    controllerSha256: t.string(),
    assetsManifestSha256: t.string(),
    engineVersion: t.string(),
    failureKinds: t.array(t.string()),
    failureSummary: t.string(),
    sourceExperimentId: t.option(t.string()),
    requirements: t.array(requirementRuleInput),
  },
  (ctx, input) => {
    requireBridge(ctx);
    const existing = ctx.db.baseline.id.find(input.id);
    const requirements = [...ctx.db.baselineRequirement.baselineId.filter(input.id)]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((row) => ({
        ruleId: row.ruleId,
        confluencePageId: row.confluencePageId,
        confluencePageRevision: row.confluencePageRevision,
        title: row.title,
        enforcement: row.enforcement as "checked" | "human_review",
        ruleJson: row.ruleJson,
        ordinal: row.ordinal,
      }));
    const baselineInput = {
      ...input,
      sourceExperimentId: input.sourceExperimentId ?? undefined,
    };
    const result = planBaselineRegister(
      existing
        ? {
            baseline: {
              id: existing.id,
              simCase: {
                ...existing.simCase,
                description: existing.simCase.description ?? undefined,
              },
              sceneSha256: existing.sceneSha256,
              controllerSha256: existing.controllerSha256,
              assetsManifestSha256: existing.assetsManifestSha256,
              engineVersion: existing.engineVersion,
              failureKinds: existing.failureKinds,
              failureSummary: existing.failureSummary,
              sourceExperimentId: existing.sourceExperimentId ?? undefined,
            },
            requirements,
          } as BaselineExisting
        : undefined,
      baselineInput as BaselineInput,
    );
    enforce(result);
    if (result.noOp) return;
    ctx.db.baseline.insert({
      id: input.id,
      simCase: {
        ...input.simCase,
        description: input.simCase.description ?? undefined,
      },
      sceneSha256: input.sceneSha256,
      controllerSha256: input.controllerSha256,
      assetsManifestSha256: input.assetsManifestSha256,
      engineVersion: input.engineVersion,
      failureKinds: input.failureKinds,
      failureSummary: input.failureSummary,
      sourceExperimentId: input.sourceExperimentId ?? undefined,
      registeredBy: ctx.sender.toHexString(),
      createdAtMs: BigInt(nowMs(ctx)),
    });
    input.requirements.forEach((requirement, ordinal) => {
      ctx.db.baselineRequirement.insert({
        key: `${input.id}:${requirement.ruleId}`,
        baselineId: input.id,
        ruleId: requirement.ruleId,
        confluencePageId: requirement.confluencePageId,
        confluencePageRevision: requirement.confluencePageRevision,
        title: requirement.title,
        enforcement: requirement.enforcement,
        ruleJson: requirement.ruleJson,
        ordinal,
      });
    });
  },
);

export const heartbeat = databaseSchema.reducer(
  { grant: grantRef },
  (ctx, { grant: ref }) => {
    const grant = requireGrant(ctx, ref, "heartbeat");
    const now = BigInt(nowMs(ctx));
    const existing = ctx.db.attemptHeartbeat.attemptId.find(ref.attemptId);
    const row = {
      attemptId: ref.attemptId,
      grantId: grant.id,
      epoch: grant.epoch,
      lastHeartbeatMs: now,
    };
    if (existing) ctx.db.attemptHeartbeat.attemptId.update(row);
    else ctx.db.attemptHeartbeat.insert(row);
  },
);

export const acquireRevisionLease = databaseSchema.reducer(
  { grant: grantRef, environmentId: t.string() },
  (ctx, { grant: ref, environmentId }) => {
    const grant = requireGrant(ctx, ref, "acquire_revision_lease");
    if (grant.environmentId !== environmentId) {
      reject("scope_mismatch", "Revision lease environment must match the grant");
    }
    const now = nowMs(ctx);
    const existing = ctx.db.revisionLease.environmentId.find(environmentId);
    const result = planLeaseAcquire(
      existing
        ? {
            environmentId: existing.environmentId,
            holderAttemptId: existing.holderAttemptId,
            grantId: existing.grantId,
            epoch: existing.epoch,
            acquiredAtMs: Number(existing.acquiredAtMs),
            renewedAtMs: Number(existing.renewedAtMs),
            expiresAtMs: Number(existing.expiresAtMs),
          }
        : undefined,
      {
        attemptId: grant.attemptId,
        id: grant.id,
        epoch: grant.epoch,
        expiresAtMs: Number(grant.expiresAtMs),
      },
      environmentId,
      now,
    );
    enforce(result);
    const row = {
      ...result.lease,
      acquiredAtMs: BigInt(result.lease.acquiredAtMs),
      renewedAtMs: BigInt(result.lease.renewedAtMs),
      expiresAtMs: BigInt(result.lease.expiresAtMs),
    };
    if (existing) ctx.db.revisionLease.environmentId.update(row);
    else ctx.db.revisionLease.insert(row);
  },
);

export const renewRevisionLease = databaseSchema.reducer(
  { grant: grantRef, environmentId: t.string() },
  (ctx, { grant: ref, environmentId }) => {
    const grant = requireGrant(ctx, ref, "renew_revision_lease");
    if (grant.environmentId !== environmentId) {
      reject("scope_mismatch", "Revision lease environment must match the grant");
    }
    const existing = ctx.db.revisionLease.environmentId.find(environmentId);
    const result = planLeaseRenew(
      existing
        ? {
            environmentId: existing.environmentId,
            holderAttemptId: existing.holderAttemptId,
            grantId: existing.grantId,
            epoch: existing.epoch,
            acquiredAtMs: Number(existing.acquiredAtMs),
            renewedAtMs: Number(existing.renewedAtMs),
            expiresAtMs: Number(existing.expiresAtMs),
          }
        : undefined,
      {
        attemptId: grant.attemptId,
        id: grant.id,
        epoch: grant.epoch,
        expiresAtMs: Number(grant.expiresAtMs),
      },
      nowMs(ctx),
    );
    enforce(result);
    ctx.db.revisionLease.environmentId.update({
      ...result.lease,
      acquiredAtMs: BigInt(result.lease.acquiredAtMs),
      renewedAtMs: BigInt(result.lease.renewedAtMs),
      expiresAtMs: BigInt(result.lease.expiresAtMs),
    });
  },
);

export const releaseRevisionLease = databaseSchema.reducer(
  { grant: grantRef, environmentId: t.string() },
  (ctx, { grant: ref, environmentId }) => {
    const grant = requireGrant(ctx, ref, "release_revision_lease");
    requireScope(grant, { environmentId });
    const lease = ctx.db.revisionLease.environmentId.find(environmentId);
    if (lease?.holderAttemptId === grant.attemptId) {
      ctx.db.revisionLease.environmentId.delete(environmentId);
    }
  },
);

export const commitRevision = databaseSchema.reducer(
  {
    grant: grantRef,
    environmentId: t.string(),
    revisionId: t.string(),
    expectedHeadRevisionId: t.option(t.string()),
    forkedFromRevisionId: t.option(t.string()),
    controllerSha256: t.string(),
    sourceArtifactId: t.string(),
    changedFunctions: t.array(t.string()),
  },
  (ctx, input) => {
    const grant = requireGrant(ctx, input.grant, "commit_revision");
    requireScope(grant, { environmentId: input.environmentId });
    validIds(input.environmentId, input.revisionId, input.expectedHeadRevisionId, input.forkedFromRevisionId, input.sourceArtifactId);
    if (!isSha256(input.controllerSha256)) reject("invalid_id", "Controller hash must be lowercase SHA-256");
    const lease = ctx.db.revisionLease.environmentId.find(input.environmentId);
    if (
      !lease ||
      lease.holderAttemptId !== grant.attemptId ||
      lease.grantId !== grant.id ||
      lease.epoch !== grant.epoch ||
      Number(lease.expiresAtMs) <= nowMs(ctx)
    ) {
      reject("lease_required", "A live revision lease is required");
    }
    const head = ctx.db.revisionHead.environmentId.find(input.environmentId);
    const headCheck = checkExpectedHead(
      head
        ? { environmentId: head.environmentId, headRevisionId: head.headRevisionId, seq: head.seq }
        : undefined,
      input.expectedHeadRevisionId ?? undefined,
    );
    enforce(headCheck);
    if (ctx.db.controllerRevision.id.find(input.revisionId)) {
      reject("duplicate_id", "Revision id already exists");
    }
    if (
      input.forkedFromRevisionId &&
      !ctx.db.controllerRevision.id.find(input.forkedFromRevisionId)
    ) {
      reject("revision_missing", "Fork source revision does not exist");
    }
    const source = ctx.db.artifactRef.id.find(input.sourceArtifactId);
    if (ctx.db.tombstone.key.find(`artifact:${input.sourceArtifactId}`)) {
      reject("artifact_tombstoned", "Revision source artifact is tombstoned");
    }
    if (
      !source ||
      source.kind !== "controller_source" ||
      source.sha256 !== input.controllerSha256
    ) {
      reject("artifact_mismatch", "Controller source artifact does not match the revision hash");
    }
    const seq = (head?.seq ?? 0) + 1;
    const createdAtMs = BigInt(nowMs(ctx));
    ctx.db.controllerRevision.insert({
      id: input.revisionId,
      environmentId: input.environmentId,
      seq,
      parentRevisionId: head?.headRevisionId,
      forkedFromRevisionId: input.forkedFromRevisionId ?? undefined,
      controllerSha256: input.controllerSha256,
      sourceArtifactId: input.sourceArtifactId,
      changedFunctions: input.changedFunctions,
      createdByAttemptId: grant.attemptId,
      grantId: grant.id,
      epoch: grant.epoch,
      createdAtMs,
    });
    const updatedHead = {
      environmentId: input.environmentId,
      headRevisionId: input.revisionId,
      seq,
      updatedAtMs: createdAtMs,
    };
    if (head) ctx.db.revisionHead.environmentId.update(updatedHead);
    else ctx.db.revisionHead.insert(updatedHead);
  },
);

export const recordArtifact = databaseSchema.reducer(
  {
    grant: grantRef,
    id: t.string(),
    kind: t.string(),
    sha256: t.string(),
    bytes: t.u64(),
    storage: t.string(),
    storageKey: t.string(),
  },
  (ctx, input) => {
    const grant = requireGrant(ctx, input.grant, "record_artifact");
    validIds(input.id);
    if (!(ARTIFACT_KINDS as readonly string[]).includes(input.kind) || !(ARTIFACT_STORAGES as readonly string[]).includes(input.storage)) {
      reject("invalid_artifact", "Artifact kind or storage is invalid");
    }
    if (!isSha256(input.sha256)) reject("invalid_id", "Artifact hash must be lowercase SHA-256");
    const existing = ctx.db.artifactRef.id.find(input.id);
    const grantData = grantLike(grant);
    if (existing) {
      const scopeCheck = checkArtifactScope({ ...grantData, maxBytes: Number(grant.maxBytes), bytesUsed: Number(grant.bytesUsed) }, input.storageKey, 0);
      enforce(scopeCheck);
      if (
        existing.kind === input.kind &&
        existing.sha256 === input.sha256 &&
        existing.bytes === input.bytes &&
        existing.storage === input.storage &&
        existing.storageKey === input.storageKey &&
        existing.grantId === grant.id
      ) {
        return;
      }
      reject("duplicate_id", "Artifact id already exists with different fields");
    }
    if (ctx.db.tombstone.key.find(`artifact:${input.id}`)) {
      reject("artifact_tombstoned", "Artifact id is tombstoned");
    }
    const result = checkArtifactScope(
      { ...grantData, maxBytes: Number(grant.maxBytes), bytesUsed: Number(grant.bytesUsed) },
      input.storageKey,
      Number(input.bytes),
    );
    enforce(result);
    ctx.db.artifactRef.insert({
      id: input.id,
      kind: input.kind,
      sha256: input.sha256,
      bytes: input.bytes,
      storage: input.storage,
      storageKey: input.storageKey,
      producedByAttemptId: grant.attemptId,
      grantId: grant.id,
      createdAtMs: BigInt(nowMs(ctx)),
    });
    ctx.db.executionGrant.id.update({
      ...grant,
      bytesUsed: grant.bytesUsed + input.bytes,
    });
  },
);

export const recordExperiment = databaseSchema.reducer(
  {
    grant: grantRef,
    id: t.string(),
    investigationId: t.string(),
    environmentId: t.option(t.string()),
    candidateId: t.option(t.string()),
    simCase: simCaseInput,
    status: t.string(),
    failureKinds: t.array(t.string()),
    completed: t.bool(),
    completionTimeSec: t.option(t.f64()),
    changedFunctions: t.array(t.string()),
    traceArtifactId: t.option(t.string()),
    replayArtifactId: t.option(t.string()),
    engineVersion: t.string(),
    assetsSha256: t.string(),
    controllerSha256: t.string(),
    startedAtMs: t.i64(),
    finishedAtMs: t.option(t.i64()),
  },
  (ctx, input) => writeExperiment(ctx, input),
);

export const commitExperiment = databaseSchema.reducer(
  {
    grant: grantRef,
    id: t.string(),
    investigationId: t.string(),
    environmentId: t.option(t.string()),
    candidateId: t.option(t.string()),
    simCase: simCaseInput,
    status: t.string(),
    failureKinds: t.array(t.string()),
    completed: t.bool(),
    completionTimeSec: t.option(t.f64()),
    changedFunctions: t.array(t.string()),
    traceArtifactId: t.option(t.string()),
    replayArtifactId: t.option(t.string()),
    engineVersion: t.string(),
    assetsSha256: t.string(),
    controllerSha256: t.string(),
    startedAtMs: t.i64(),
    finishedAtMs: t.option(t.i64()),
    replicationOf: t.option(t.string()),
    replicationReason: t.option(t.string()),
  },
  (ctx, input) => writeExperiment(ctx, input, input.replicationOf, input.replicationReason),
);

export const recordFinding = databaseSchema.reducer(
  {
    grant: grantRef,
    id: t.string(),
    investigationId: t.string(),
    environmentId: t.string(),
    sessionId: t.option(t.string()),
    kind: t.string(),
    claim: t.string(),
    summary: t.string(),
    evidence: t.array(evidenceInput),
    links: t.array(findingLinkInput),
  },
  (ctx, input) => {
    const grant = requireGrant(ctx, input.grant, "record_finding");
    requireScope(grant, {
      investigationId: input.investigationId,
      environmentId: input.environmentId,
    });
    validIds(input.id, input.investigationId, input.environmentId, input.sessionId ?? undefined);
    for (const item of input.evidence) {
      validIds(item.artifactId ?? undefined, item.experimentId ?? undefined);
    }
    for (const link of input.links) validIds(link.toFindingId);
    const validation = validateFindingInput(input);
    enforce(validation);
    for (const item of input.evidence) {
      if (item.artifactId && !ctx.db.artifactRef.id.find(item.artifactId)) {
        reject("artifact_missing", "Finding artifact does not exist");
      }
      if (item.experimentId && !resolveExperiment(ctx, item.experimentId)) {
        reject("experiment_missing", "Finding experiment does not exist");
      }
    }
    for (const link of input.links) {
      if (!ctx.db.finding.id.find(link.toFindingId)) {
        reject("finding_missing", "Finding link target does not exist");
      }
    }
    const existing = ctx.db.finding.id.find(input.id);
    if (existing) {
      const oldEvidence = [...ctx.db.evidence.findingId.filter(input.id)]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ kind, artifactId, experimentId, locatorJson, excerpt }) => ({
          kind,
          artifactId,
          experimentId,
          locatorJson,
          excerpt,
        }));
      const oldLinks = [...ctx.db.findingLink.fromFindingId.filter(input.id)].map(
        ({ toFindingId, relation }) => ({ toFindingId, relation }),
      );
      const identical =
        existing.investigationId === input.investigationId &&
        existing.environmentId === input.environmentId &&
        existing.sessionId === (input.sessionId ?? undefined) &&
        existing.kind === input.kind &&
        existing.claim === input.claim &&
        existing.summary === input.summary &&
        existing.createdByAttemptId === grant.attemptId &&
        existing.grantId === grant.id &&
        existing.epoch === grant.epoch &&
        sameJson(oldEvidence, input.evidence.map((item) => ({
          ...item,
          artifactId: item.artifactId ?? undefined,
          experimentId: item.experimentId ?? undefined,
          excerpt: item.excerpt ?? undefined,
        }))) &&
        sameJson(oldLinks, input.links);
      if (identical) return;
      reject("duplicate_id", "Finding id already exists with different fields");
    }

    for (const item of input.evidence) {
      if (item.artifactId && ctx.db.tombstone.key.find(`artifact:${item.artifactId}`)) {
        reject("artifact_tombstoned", "Finding evidence artifact is tombstoned");
      }
      if (item.experimentId) {
        const sourceExperiment = resolveExperiment(ctx, item.experimentId);
        if (sourceExperiment && experimentRowIsTombstoned(ctx, sourceExperiment)) {
          reject("artifact_tombstoned", "Finding evidence experiment references a tombstoned artifact");
        }
      }
    }
    for (const link of input.links) {
      if (ctx.db.tombstone.key.find(`finding:${link.toFindingId}`)) {
        reject("finding_tombstoned", "Finding link target is tombstoned");
      }
    }
    if (ctx.db.tombstone.key.find(`finding:${input.id}`)) {
      reject("finding_tombstoned", "Finding id is tombstoned");
    }

    ctx.db.finding.insert({
      id: input.id,
      investigationId: input.investigationId,
      environmentId: input.environmentId,
      sessionId: input.sessionId ?? undefined,
      kind: input.kind,
      claim: input.claim,
      summary: input.summary,
      createdByAttemptId: grant.attemptId,
      grantId: grant.id,
      epoch: grant.epoch,
      createdAtMs: BigInt(nowMs(ctx)),
    });
    input.evidence.forEach((item, ordinal) => {
      ctx.db.evidence.insert({
        id: 0n,
        findingId: input.id,
        ordinal,
        kind: item.kind,
        artifactId: item.artifactId ?? undefined,
        experimentId: item.experimentId ?? undefined,
        locatorJson: item.locatorJson,
        excerpt: item.excerpt ?? undefined,
        environmentId: input.environmentId,
      });
    });
    for (const link of input.links) {
      ctx.db.findingLink.insert({
        id: 0n,
        fromFindingId: input.id,
        toFindingId: link.toFindingId,
        relation: link.relation,
      });
    }
    enqueueFor(
      ctx,
      "elastic_index",
      `finding:${input.id}:elastic_index`,
      { kind: "finding", id: input.id },
      "finding",
      input.id,
    );
  },
);

export const recordFindingUse = databaseSchema.reducer(
  {
    grant: grantRef,
    id: t.string(),
    findingId: t.string(),
    experimentId: t.option(t.string()),
    candidateId: t.option(t.string()),
  },
  (ctx, input) => {
    const operation = input.experimentId === undefined ? "submit_candidate" : "record_experiment";
    const grant = requireGrant(ctx, input.grant, operation);
    writeFindingUse(ctx, grant, {
      id: input.id,
      findingId: input.findingId,
      experimentId: input.experimentId ?? undefined,
      candidateId: input.candidateId ?? undefined,
    });
  },
);

export const submitCandidate = databaseSchema.reducer(
  {
    grant: grantRef,
    id: t.string(),
    investigationId: t.string(),
    environmentId: t.string(),
    revisionId: t.option(t.string()),
    controllerSha256: t.string(),
    sourceArtifactId: t.string(),
    changedFunctions: t.array(t.string()),
    rationale: t.option(t.string()),
    basedOnFindings: t.array(t.string()),
  },
  (ctx, input) => {
    const grant = requireGrant(ctx, input.grant, "submit_candidate");
    requireScope(grant, {
      investigationId: input.investigationId,
      environmentId: input.environmentId,
    });
    validIds(
      input.id,
      input.investigationId,
      input.environmentId,
      input.revisionId ?? undefined,
      input.sourceArtifactId,
      ...input.basedOnFindings,
    );
    if (!isSha256(input.controllerSha256)) reject("invalid_id", "Controller hash must be lowercase SHA-256");
    const existing = ctx.db.candidate.id.find(input.id);
    if (existing) {
      const identical =
        existing.investigationId === input.investigationId &&
        existing.environmentId === input.environmentId &&
        existing.revisionId === (input.revisionId ?? undefined) &&
        existing.controllerSha256 === input.controllerSha256 &&
        existing.sourceArtifactId === input.sourceArtifactId &&
        sameJson(existing.changedFunctions, input.changedFunctions) &&
        existing.rationale === (input.rationale ?? undefined) &&
        sameJson(existing.basedOnFindings, input.basedOnFindings) &&
        existing.submittedByAttemptId === grant.attemptId &&
        existing.grantId === grant.id &&
        existing.epoch === grant.epoch;
      if (identical) return;
      reject("immutable_candidate", "Candidate id is immutable");
    }
    if (ctx.db.tombstone.key.find(`artifact:${input.sourceArtifactId}`)) {
      reject("artifact_tombstoned", "Candidate source artifact is tombstoned");
    }
    if (ctx.db.tombstone.key.find(`candidate:${input.id}`)) {
      reject("candidate_tombstoned", "Candidate id is tombstoned");
    }
    const artifact = ctx.db.artifactRef.id.find(input.sourceArtifactId);
    if (
      !artifact ||
      artifact.kind !== "controller_source" ||
      artifact.sha256 !== input.controllerSha256
    ) {
      reject("artifact_mismatch", "Candidate source artifact does not match the controller hash");
    }
    if (input.revisionId) {
      const revision = ctx.db.controllerRevision.id.find(input.revisionId);
      if (
        !revision ||
        revision.environmentId !== input.environmentId ||
        revision.controllerSha256 !== input.controllerSha256
      ) {
        reject("revision_mismatch", "Candidate revision must match its environment and controller hash");
      }
      if (ctx.db.tombstone.key.find(`revision:${input.revisionId}`)) {
        reject("revision_tombstoned", "Candidate source revision is tombstoned");
      }
    }
    for (const findingId of input.basedOnFindings) {
      if (!ctx.db.finding.id.find(findingId)) reject("finding_missing", "Candidate finding does not exist");
      if (ctx.db.tombstone.key.find(`finding:${findingId}`)) {
        reject("finding_tombstoned", "Candidate cannot reference a tombstoned finding");
      }
    }
    ctx.db.candidate.insert({
      id: input.id,
      investigationId: input.investigationId,
      environmentId: input.environmentId,
      revisionId: input.revisionId ?? undefined,
      controllerSha256: input.controllerSha256,
      sourceArtifactId: input.sourceArtifactId,
      changedFunctions: input.changedFunctions,
      rationale: input.rationale ?? undefined,
      basedOnFindings: input.basedOnFindings,
      submittedByAttemptId: grant.attemptId,
      grantId: grant.id,
      epoch: grant.epoch,
      submittedAtMs: BigInt(nowMs(ctx)),
    });
    for (const findingId of input.basedOnFindings) {
      writeFindingUse(ctx, grant, {
        id: ctx.newUuidV4().toString(),
        findingId,
        candidateId: input.id,
      });
    }
    enqueueFor(
      ctx,
      "elastic_index",
      `candidate:${input.id}:elastic_index`,
      { kind: "candidate", id: input.id },
      "candidate",
      input.id,
    );
  },
);

export const recordEvaluation = databaseSchema.reducer(
  {
    grant: grantRef,
    id: t.string(),
    candidateId: t.string(),
    investigationId: t.string(),
    suite: t.string(),
    cases: t.array(caseEvaluationInput),
    allRequiredPassed: t.bool(),
    medianCompletionTimeSec: t.option(t.f64()),
    status: t.string(),
    reportArtifactId: t.option(t.string()),
  },
  (ctx, input) => {
    const grant = requireGrant(ctx, input.grant, "record_evaluation");
    if (grant.environmentId !== undefined) {
      reject("evaluator_only", "Only environment-independent evaluator grants may write evaluations");
    }
    requireScope(grant, { investigationId: input.investigationId });
    validIds(input.id, input.candidateId, input.investigationId, input.reportArtifactId ?? undefined);
    if (!["public", "withheld"].includes(input.suite)) reject("invalid_evaluation", "Evaluation suite is invalid");
    if (!(EVALUATION_STATUSES as readonly string[]).includes(input.status)) {
      reject("invalid_evaluation", "Evaluation status is invalid");
    }
    for (const item of input.cases) {
      if (!(EVALUATION_STATUSES as readonly string[]).includes(item.status)) {
        reject("invalid_evaluation", "Case evaluation status is invalid");
      }
      validIds(item.experimentId ?? undefined);
      if (item.experimentId && !resolveExperiment(ctx, item.experimentId)) {
        reject("experiment_missing", "Evaluation experiment does not exist");
      }
      const caseExperiment = item.experimentId ? resolveExperiment(ctx, item.experimentId) : undefined;
      if (caseExperiment && experimentRowIsTombstoned(ctx, caseExperiment)) {
        reject("artifact_tombstoned", "Evaluation experiment references a tombstoned artifact");
      }
    }
    const submitted = ctx.db.candidate.id.find(input.candidateId);
    if (!submitted || submitted.investigationId !== input.investigationId) {
      reject("candidate_missing", "Evaluation candidate does not exist in this investigation");
    }
    if (
      input.reportArtifactId &&
      !ctx.db.artifactRef.id.find(input.reportArtifactId)
    ) {
      reject("artifact_missing", "Evaluation report artifact does not exist");
    }
    const existing = ctx.db.evaluation.id.find(input.id);
    const cases = input.cases.map((item) => ({
      ...item,
      experimentId: item.experimentId ?? undefined,
      completionTimeSec: item.completionTimeSec ?? undefined,
    }));
    if (
      existing &&
      existing.candidateId === input.candidateId &&
      existing.investigationId === input.investigationId &&
      existing.evaluatorAttemptId === grant.attemptId &&
      existing.grantId === grant.id &&
      existing.suite === input.suite &&
      sameJson(existing.cases, cases) &&
      existing.allRequiredPassed === input.allRequiredPassed &&
      existing.medianCompletionTimeSec === (input.medianCompletionTimeSec ?? undefined) &&
      existing.status === input.status &&
      existing.reportArtifactId === (input.reportArtifactId ?? undefined)
    ) return;
    if (ctx.db.tombstone.key.find(`candidate:${input.candidateId}`)) {
      reject("candidate_tombstoned", "Evaluation candidate is tombstoned");
    }
    if (
      input.reportArtifactId &&
      ctx.db.tombstone.key.find(`artifact:${input.reportArtifactId}`)
    ) {
      reject("artifact_tombstoned", "Evaluation report artifact is tombstoned");
    }
    const plan = planEvaluationWrite(
      existing
        ? {
            id: existing.id,
            candidateId: existing.candidateId,
            evaluatorAttemptId: existing.evaluatorAttemptId,
            status: existing.status,
          }
        : undefined,
      {
        id: input.id,
        candidateId: input.candidateId,
        evaluatorAttemptId: grant.attemptId,
        status: input.status,
      },
      grant.attemptId,
    );
    enforce(plan);
    if (existing && existing.candidateId !== input.candidateId) {
      reject("duplicate_id", "Evaluation id belongs to another candidate");
    }
    const now = BigInt(nowMs(ctx));
    const row = {
      id: input.id,
      candidateId: input.candidateId,
      investigationId: input.investigationId,
      evaluatorAttemptId: grant.attemptId,
      grantId: grant.id,
      suite: input.suite,
      cases,
      allRequiredPassed: input.allRequiredPassed,
      medianCompletionTimeSec: input.medianCompletionTimeSec ?? undefined,
      status: input.status,
      reportArtifactId: input.reportArtifactId ?? undefined,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };
    if (existing) ctx.db.evaluation.id.update(row);
    else ctx.db.evaluation.insert(row);
    if (["passed", "failed", "invalid"].includes(input.status)) {
      enqueueFor(
        ctx,
        "elastic_index",
        `evaluation:${input.id}:elastic_index`,
        { kind: "evaluation", id: input.id },
        "evaluation",
        input.id,
      );
    }
  },
);

export const recordReview = databaseSchema.reducer(
  {
    id: t.string(),
    investigationId: t.string(),
    candidateId: t.string(),
    evaluationId: t.string(),
    controllerSha256: t.string(),
    decision: t.string(),
    reviewerIdentity: t.string(),
    notes: t.option(t.string()),
    jiraIssueKey: t.option(t.string()),
  },
  (ctx, input) => {
    requireBridge(ctx);
    validIds(input.id, input.investigationId, input.candidateId, input.evaluationId);
    const candidateRow = ctx.db.candidate.id.find(input.candidateId);
    const evaluationRow = ctx.db.evaluation.id.find(input.evaluationId);
    if (!evaluationRow || !["passed", "failed", "invalid"].includes(evaluationRow.status)) {
      reject("evaluation_not_terminal", "Review requires a terminal evaluation");
    }
    if (evaluationRow.candidateId !== input.candidateId) {
      reject("candidate_mismatch", "Evaluation does not belong to the reviewed candidate");
    }
    if (!candidateRow || candidateRow.investigationId !== input.investigationId) {
      reject("candidate_missing", "Candidate does not exist in this investigation");
    }
    if (ctx.db.tombstone.key.find(`candidate:${input.candidateId}`)) {
      reject("candidate_tombstoned", "Review candidate is tombstoned");
    }
    if (candidateRow.controllerSha256 !== input.controllerSha256) {
      reject("sha_mismatch", "Review hash does not match the candidate");
    }
    if (!(REVIEW_DECISIONS as readonly string[]).includes(input.decision)) {
      reject("invalid_review", "Review decision is invalid");
    }
    if (ctx.db.humanReview.id.find(input.id)) reject("duplicate_id", "Review id already exists");
    ctx.db.humanReview.insert({
      ...input,
      notes: input.notes ?? undefined,
      jiraIssueKey: input.jiraIssueKey ?? undefined,
      createdAtMs: BigInt(nowMs(ctx)),
    });
    enqueueFor(
      ctx,
      "jira_sync",
      `review:${input.id}:jira_sync`,
      { kind: "review", id: input.id },
      "review",
      input.id,
    );
  },
);

export const recordControllerPromotion = databaseSchema.reducer(
  {
    id: t.string(),
    taskFamily: t.string(),
    version: t.u32(),
    controllerSha256: t.string(),
    parentControllerSha256: t.string(),
    investigationId: t.string(),
    candidateId: t.string(),
    reviewId: t.string(),
  },
  (ctx, input) => {
    requireBridge(ctx);
    validIds(input.id, input.investigationId, input.candidateId, input.reviewId);
    const review = ctx.db.humanReview.id.find(input.reviewId);
    if (!review || review.decision !== "approved") {
      reject("approved_review_required", "Controller promotion requires an approved review");
    }
    if (review.controllerSha256 !== input.controllerSha256 || review.candidateId !== input.candidateId
      || review.investigationId !== input.investigationId) {
      reject("review_mismatch", "Promotion does not match the approved review");
    }
    if (ctx.db.controllerPromotion.id.find(input.id)) {
      reject("duplicate_id", "Controller promotion id already exists");
    }
    if ([...ctx.db.controllerPromotion.by_task_family.filter(input.taskFamily)].some((row) => row.version === input.version)) {
      reject("duplicate_version", "Controller promotion version already exists for this task family");
    }
    ctx.db.controllerPromotion.insert({
      ...input,
      createdAtMs: BigInt(nowMs(ctx)),
    });
  },
);

export const outboxEnqueue = databaseSchema.reducer(
  {
    grant: t.option(grantRef),
    id: t.string(),
    destination: t.string(),
    idempotencyKey: t.string(),
    operationId: t.string(),
    payloadJson: t.string(),
    sourceKind: t.string(),
    sourceId: t.string(),
  },
  (ctx, input) => {
    if (!ctx.db.bridgeIdentity.identity.find(ctx.sender)) {
      if (!input.grant) reject("bridge_required", "A bridge or execution grant is required");
      requireGrant(ctx, input.grant, "outbox_enqueue");
    }
    validIds(input.id, input.operationId, input.sourceId);
    if (!(OUTBOX_DESTINATIONS as readonly string[]).includes(input.destination)) {
      reject("invalid_outbox", "Outbox destination is invalid");
    }
    parseObjectJson(input.payloadJson, "invalid_outbox");
    const { id, destination, idempotencyKey, operationId, payloadJson, sourceKind, sourceId } = input;
    upsertOutbox(ctx, { id, destination, idempotencyKey, operationId, payloadJson, sourceKind, sourceId });
  },
);

export const outboxMarkDelivered = databaseSchema.reducer(
  { idempotencyKey: t.string() },
  (ctx, { idempotencyKey }) => {
    requireBridge(ctx);
    const entry = ctx.db.outboxEntry.idempotencyKey.find(idempotencyKey);
    if (!entry) reject("outbox_missing", "Outbox entry does not exist");
    if (entry.status === "delivered") return;
    if (entry.status === "dead") reject("outbox_dead", "Dead outbox entries cannot be delivered");
    ctx.db.outboxEntry.id.update({
      ...entry,
      status: "delivered",
      deliveredAtMs: BigInt(nowMs(ctx)),
    });
  },
);

export const outboxMarkFailed = databaseSchema.reducer(
  { idempotencyKey: t.string(), error: t.string() },
  (ctx, { idempotencyKey, error }) => {
    requireBridge(ctx);
    const entry = ctx.db.outboxEntry.idempotencyKey.find(idempotencyKey);
    if (!entry) reject("outbox_missing", "Outbox entry does not exist");
    if (entry.status === "delivered") return;
    const failure = planOutboxFailure(entry);
    ctx.db.outboxEntry.id.update({
      ...entry,
      attempts: failure.attempts,
      status: failure.status,
      lastError: error.slice(0, 1_000),
    });
  },
);

export const recordTombstone = databaseSchema.reducer(
  { targetKind: t.string(), targetId: t.string(), reason: t.string() },
  (ctx, input) => {
    requireBridge(ctx);
    if (!(TOMBSTONE_TARGET_KINDS as readonly string[]).includes(input.targetKind)) {
      reject("invalid_tombstone", "Tombstone target kind is invalid");
    }
    if (
      input.targetKind === "evidence" &&
      (!/^(0|[1-9]\d{0,19})$/.test(input.targetId) || BigInt(input.targetId) > 18_446_744_073_709_551_615n)
    ) {
      reject("invalid_id", "Evidence tombstone id must be a decimal u64 string");
    }
    if (input.targetKind !== "evidence" && !isUuid(input.targetId)) {
      reject("invalid_id", "Tombstone target id must be a UUID");
    }
    const key = `${input.targetKind}:${input.targetId}`;
    if (ctx.db.tombstone.key.find(key)) return;
    ctx.db.tombstone.insert({
      key,
      targetKind: input.targetKind,
      targetId: input.targetId,
      reason: input.reason,
      createdAtMs: BigInt(nowMs(ctx)),
    });
    enqueueFor(
      ctx,
      "elastic_index",
      `tombstone:${input.targetKind}:${input.targetId}:elastic_index`,
      { operation: "delete", targetKind: input.targetKind, targetId: input.targetId },
      "tombstone",
      key,
    );
  },
);
