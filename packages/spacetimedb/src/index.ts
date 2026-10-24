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
  isSha256,
  isUuid,
  planEvaluationWrite,
  planGrantInstall,
  planLeaseAcquire,
  planLeaseRenew,
  planOutboxEnqueue,
  planBridgeRotation,
  planOutboxFailure,
  secretsMatch,
  validateFindingUse,
  validateFindingInput,
  validateGrantUse,
  type GrantLike,
  type GrantRef,
  type OutboxInput,
} from "./logic/index.js";
import databaseSchema, {
  artifactRef,
  attemptHeartbeat,
  bridgeIdentity,
  candidate,
  controllerRevision,
  evaluation,
  evidence,
  executionGrant,
  experiment,
  finding,
  findingLink,
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
  return JSON.stringify(left) === JSON.stringify(right);
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

export const registerBridge = databaseSchema.reducer(
  { secret: t.string() },
  (ctx, { secret }) => {
    requireBridgeSecret(ctx, secret);
    upsertBridgeIdentity(ctx);
  },
);

/** Registers the caller as the only "convex" bridge identity. Runs in one
 *  reducer transaction, so stale identities lose authority atomically. */
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
  (ctx, input) => {
    const grant = requireGrant(ctx, input.grant, "record_experiment");
    requireScope(grant, {
      investigationId: input.investigationId,
      environmentId: input.environmentId ?? undefined,
    });
    validIds(
      input.id,
      input.investigationId,
      input.environmentId ?? undefined,
      input.candidateId ?? undefined,
      input.traceArtifactId ?? undefined,
      input.replayArtifactId ?? undefined,
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
    ctx.db.experiment.insert({
      ...input,
      environmentId: input.environmentId ?? undefined,
      candidateId: input.candidateId ?? undefined,
      attemptId: grant.attemptId,
      epoch: grant.epoch,
      grantId: grant.id,
      simCase: {
        ...input.simCase,
        description: input.simCase.description ?? undefined,
      },
      completionTimeSec: input.completionTimeSec ?? undefined,
      traceArtifactId: input.traceArtifactId ?? undefined,
      replayArtifactId: input.replayArtifactId ?? undefined,
      finishedAtMs: input.finishedAtMs ?? undefined,
    });
  },
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
      if (item.experimentId && !ctx.db.experiment.id.find(item.experimentId)) {
        reject("experiment_missing", "Finding experiment does not exist");
      }
    }
    for (const link of input.links) {
      if (!ctx.db.finding.id.find(link.toFindingId)) {
        reject("finding_missing", "Finding link target does not exist");
      }
      if (ctx.db.tombstone.key.find(`finding:${link.toFindingId}`)) {
        reject("finding_tombstoned", "Finding link target is tombstoned");
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
    const grant = requireGrant(ctx, input.grant, "record_finding");
    const experimentId = input.experimentId ?? undefined;
    const candidateId = input.candidateId ?? undefined;
    validIds(input.id, input.findingId, experimentId, candidateId);
    const finding = ctx.db.finding.id.find(input.findingId);
    const experimentRow = experimentId ? ctx.db.experiment.id.find(experimentId) : undefined;
    const candidateRow = candidateId ? ctx.db.candidate.id.find(candidateId) : undefined;
    const targetRow = experimentRow
      ? { investigationId: experimentRow.investigationId, environmentId: experimentRow.environmentId ?? undefined }
      : candidateRow
        ? { investigationId: candidateRow.investigationId, environmentId: candidateRow.environmentId }
        : undefined;
    const existing = ctx.db.findingUse.id.find(input.id);
    const check = validateFindingUse({
      grant: { investigationId: grant.investigationId, environmentId: grant.environmentId ?? undefined },
      finding: finding ? { investigationId: finding.investigationId, environmentId: finding.environmentId } : undefined,
      findingTombstoned: Boolean(ctx.db.tombstone.key.find(`finding:${input.findingId}`)),
      targetCount: (experimentId ? 1 : 0) + (candidateId ? 1 : 0),
      target: targetRow,
      existing: existing
        ? { findingId: existing.findingId, experimentId: existing.experimentId ?? undefined, candidateId: existing.candidateId ?? undefined }
        : undefined,
      requested: { findingId: input.findingId, experimentId, candidateId },
    });
    enforce(check);
    if (check.duplicate || !finding || !targetRow) return;
    ctx.db.findingUse.insert({
      id: input.id,
      investigationId: grant.investigationId,
      findingId: input.findingId,
      findingEnvironmentId: finding.environmentId,
      usedByEnvironmentId: (grant.environmentId ?? targetRow.environmentId)!,
      experimentId,
      candidateId,
      createdByAttemptId: grant.attemptId,
      createdAtMs: BigInt(nowMs(ctx)),
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
      if (item.experimentId && !ctx.db.experiment.id.find(item.experimentId)) {
        reject("experiment_missing", "Evaluation experiment does not exist");
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
      cases: input.cases.map((item) => ({
        ...item,
        experimentId: item.experimentId ?? undefined,
        completionTimeSec: item.completionTimeSec ?? undefined,
      })),
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
      input.targetKind !== "evidence" &&
      !isUuid(input.targetId)
    ) {
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
