import { schema, table, t } from "spacetimedb/server";

const simCase = t.object("SimCase", {
  caseId: t.string(),
  suite: t.string(),
  seed: t.u32(),
  sceneOverridesJson: t.string(),
  description: t.option(t.string()),
});

const caseEvaluation = t.object("CaseEvaluation", {
  caseId: t.string(),
  status: t.string(),
  experimentId: t.option(t.string()),
  completionTimeSec: t.option(t.f64()),
  failureKinds: t.array(t.string()),
});

export const bridgeIdentity = table(
  { name: "bridge_identity" },
  {
    identity: t.identity().primaryKey(),
    role: t.string(),
    registeredAtMs: t.i64(),
  },
);

export const jobFence = table(
  { name: "job_fence", public: true },
  {
    jobId: t.string().primaryKey(),
    epoch: t.u32(),
    grantId: t.string(),
    updatedAtMs: t.i64(),
  },
);

export const executionGrant = table(
  { name: "execution_grant", public: true },
  {
    id: t.string().primaryKey(),
    jobId: t.string().index("btree"),
    attemptId: t.string(),
    epoch: t.u32(),
    investigationId: t.string(),
    environmentId: t.option(t.string()),
    operations: t.array(t.string()),
    artifactPrefixes: t.array(t.string()),
    maxBytes: t.u64(),
    bytesUsed: t.u64(),
    expiresAtMs: t.i64(),
    revokedAtMs: t.option(t.i64()),
    revokeReason: t.option(t.string()),
    holder: t.option(t.identity()),
    installedAtMs: t.i64(),
  },
);

export const revisionHead = table(
  { name: "revision_head", public: true },
  {
    environmentId: t.string().primaryKey(),
    headRevisionId: t.string(),
    seq: t.u32(),
    updatedAtMs: t.i64(),
  },
);

export const controllerRevision = table(
  {
    name: "controller_revision",
    public: true,
    indexes: [
      {
        accessor: "by_env_seq",
        algorithm: "btree",
        columns: ["environmentId", "seq"],
      },
    ],
  },
  {
    id: t.string().primaryKey(),
    environmentId: t.string().index("btree"),
    seq: t.u32(),
    parentRevisionId: t.option(t.string()),
    forkedFromRevisionId: t.option(t.string()),
    controllerSha256: t.string(),
    sourceArtifactId: t.string(),
    changedFunctions: t.array(t.string()),
    createdByAttemptId: t.string(),
    grantId: t.string(),
    epoch: t.u32(),
    createdAtMs: t.i64(),
  },
);

export const revisionLease = table(
  { name: "revision_lease", public: true },
  {
    environmentId: t.string().primaryKey(),
    holderAttemptId: t.string(),
    grantId: t.string(),
    epoch: t.u32(),
    acquiredAtMs: t.i64(),
    renewedAtMs: t.i64(),
    expiresAtMs: t.i64(),
  },
);

export const artifactRef = table(
  { name: "artifact_ref", public: true },
  {
    id: t.string().primaryKey(),
    kind: t.string(),
    sha256: t.string(),
    bytes: t.u64(),
    storage: t.string(),
    storageKey: t.string(),
    producedByAttemptId: t.string(),
    grantId: t.string(),
    createdAtMs: t.i64(),
  },
);

export const experiment = table(
  { name: "experiment", public: true },
  {
    id: t.string().primaryKey(),
    investigationId: t.string().index("btree"),
    environmentId: t.option(t.string()),
    candidateId: t.option(t.string()),
    attemptId: t.string(),
    epoch: t.u32(),
    grantId: t.string(),
    simCase,
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
);

export const baseline = table(
  { name: "baseline", public: true },
  {
    id: t.string().primaryKey(),
    simCase,
    sceneSha256: t.string(),
    controllerSha256: t.string(),
    assetsManifestSha256: t.string(),
    engineVersion: t.string(),
    failureKinds: t.array(t.string()),
    failureSummary: t.string(),
    sourceExperimentId: t.option(t.string()),
    registeredBy: t.string(),
    createdAtMs: t.i64(),
  },
);

export const baselineRequirement = table(
  { name: "baseline_requirement", public: true },
  {
    key: t.string().primaryKey(),
    baselineId: t.string().index("btree"),
    ruleId: t.string(),
    confluencePageId: t.string(),
    confluencePageRevision: t.u32(),
    title: t.string(),
    enforcement: t.string(),
    ruleJson: t.string(),
    ordinal: t.u32(),
  },
);

export const experimentIdentity = table(
  { name: "experiment_identity", public: true },
  {
    experimentId: t.string().primaryKey(),
    investigationId: t.string().index("btree"),
    identityHash: t.string().index("btree"),
    authorClass: t.string(),
    role: t.string(),
    canonicalExperimentId: t.string(),
    replicationOfExperimentId: t.option(t.string()),
    replicationReason: t.option(t.string()),
    environmentId: t.option(t.string()),
    candidateId: t.option(t.string()),
    grantId: t.string(),
    createdAtMs: t.i64(),
  },
);

export const finding = table(
  { name: "finding", public: true },
  {
    id: t.string().primaryKey(),
    investigationId: t.string().index("btree"),
    environmentId: t.string(),
    sessionId: t.option(t.string()),
    kind: t.string(),
    claim: t.string(),
    summary: t.string(),
    createdByAttemptId: t.string(),
    grantId: t.string(),
    epoch: t.u32(),
    createdAtMs: t.i64(),
  },
);

export const evidence = table(
  { name: "evidence", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    findingId: t.string().index("btree"),
    ordinal: t.u32(),
    kind: t.string(),
    artifactId: t.option(t.string()),
    experimentId: t.option(t.string()),
    locatorJson: t.string(),
    excerpt: t.option(t.string()),
    environmentId: t.string(),
  },
);

export const findingLink = table(
  { name: "finding_link", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fromFindingId: t.string().index("btree"),
    toFindingId: t.string(),
    relation: t.string(),
  },
);

export const candidate = table(
  { name: "candidate", public: true },
  {
    id: t.string().primaryKey(),
    investigationId: t.string().index("btree"),
    environmentId: t.string(),
    revisionId: t.option(t.string()),
    controllerSha256: t.string(),
    sourceArtifactId: t.string(),
    changedFunctions: t.array(t.string()),
    rationale: t.option(t.string()),
    basedOnFindings: t.array(t.string()),
    submittedByAttemptId: t.string(),
    grantId: t.string(),
    epoch: t.u32(),
    submittedAtMs: t.i64(),
  },
);

export const evaluation = table(
  { name: "evaluation", public: true },
  {
    id: t.string().primaryKey(),
    candidateId: t.string().index("btree"),
    investigationId: t.string(),
    evaluatorAttemptId: t.string(),
    grantId: t.string(),
    suite: t.string(),
    cases: t.array(caseEvaluation),
    allRequiredPassed: t.bool(),
    medianCompletionTimeSec: t.option(t.f64()),
    status: t.string(),
    reportArtifactId: t.option(t.string()),
    createdAtMs: t.i64(),
    updatedAtMs: t.i64(),
  },
);

export const humanReview = table(
  { name: "human_review", public: true },
  {
    id: t.string().primaryKey(),
    investigationId: t.string(),
    candidateId: t.string().index("btree"),
    evaluationId: t.string(),
    controllerSha256: t.string(),
    decision: t.string(),
    reviewerIdentity: t.string(),
    notes: t.option(t.string()),
    jiraIssueKey: t.option(t.string()),
    createdAtMs: t.i64(),
  },
);

export const controllerPromotion = table(
  {
    name: "controller_promotion",
    public: true,
    indexes: [
      {
        accessor: "by_task_family",
        algorithm: "btree",
        columns: ["taskFamily"],
      },
    ],
  },
  {
    id: t.string().primaryKey(),
    taskFamily: t.string(),
    version: t.u32(),
    controllerSha256: t.string(),
    parentControllerSha256: t.string(),
    investigationId: t.string(),
    candidateId: t.string(),
    reviewId: t.string(),
    createdAtMs: t.i64(),
  },
);

export const outboxEntry = table(
  { name: "outbox_entry", public: true },
  {
    id: t.string().primaryKey(),
    idempotencyKey: t.string().unique(),
    destination: t.string(),
    status: t.string(),
    operationId: t.string(),
    payloadJson: t.string(),
    sourceKind: t.string(),
    sourceId: t.string(),
    attempts: t.u32(),
    lastError: t.option(t.string()),
    createdAtMs: t.i64(),
    deliveredAtMs: t.option(t.i64()),
  },
);

export const tombstone = table(
  { name: "tombstone", public: true },
  {
    key: t.string().primaryKey(),
    targetKind: t.string(),
    targetId: t.string(),
    reason: t.string(),
    createdAtMs: t.i64(),
  },
);

export const findingUse = table(
  { name: "finding_use", public: true },
  {
    id: t.string().primaryKey(),
    useKey: t.string().unique(),
    findingId: t.string().index("btree"),
    findingInvestigationId: t.string(),
    findingEnvironmentId: t.string(),
    usedByEnvironmentId: t.string(),
    experimentId: t.option(t.string()),
    candidateId: t.option(t.string()),
    crossEnvironment: t.bool(),
    grantId: t.string(),
    attemptId: t.string(),
    epoch: t.u32(),
    createdAtMs: t.i64(),
  },
);

export const attemptHeartbeat = table(
  { name: "attempt_heartbeat", public: true },
  {
    attemptId: t.string().primaryKey(),
    grantId: t.string(),
    epoch: t.u32(),
    lastHeartbeatMs: t.i64(),
  },
);

const databaseSchema = schema(
  {
    bridgeIdentity,
    jobFence,
    executionGrant,
    revisionHead,
    controllerRevision,
    revisionLease,
    artifactRef,
    experiment,
    baseline,
    baselineRequirement,
    experimentIdentity,
    finding,
    evidence,
    findingLink,
    findingUse,
    candidate,
    evaluation,
    humanReview,
    controllerPromotion,
    outboxEntry,
    tombstone,
    attemptHeartbeat,
  },
  { env: { FORKSAFE_BRIDGE_SECRET: t.option(t.string()) } },
);

export const liveFinding = databaseSchema.anonymousView(
  { name: "live_finding", public: true },
  t.array(finding.rowType),
  (ctx) => {
    const revoked = new Set(
      [...ctx.db.tombstone.iter()]
        .filter((row) => row.targetKind === "finding")
        .map((row) => row.targetId),
    );
    return [...ctx.db.finding.iter()].filter((row) => !revoked.has(row.id));
  },
);

export const liveEvidence = databaseSchema.anonymousView(
  { name: "live_evidence", public: true },
  t.array(evidence.rowType),
  (ctx) => {
    const tombstoneRows = [...ctx.db.tombstone.iter()];
    const findingTombstones = new Set(
      tombstoneRows.filter((row) => row.targetKind === "finding").map((row) => row.targetId),
    );
    const evidenceTombstones = new Set(
      tombstoneRows.filter((row) => row.targetKind === "evidence").map((row) => row.targetId),
    );
    const artifactTombstones = new Set(
      tombstoneRows.filter((row) => row.targetKind === "artifact").map((row) => row.targetId),
    );
    const experiments = new Map([...ctx.db.experiment.iter()].map((row) => [row.id, row]));
    const identities = new Map([...ctx.db.experimentIdentity.iter()].map((row) => [row.experimentId, row]));
    return [...ctx.db.evidence.iter()].filter((row) => {
      if (findingTombstones.has(row.findingId) || evidenceTombstones.has(row.id.toString())) return false;
      if (row.artifactId !== undefined && artifactTombstones.has(row.artifactId)) return false;
      if (row.experimentId !== undefined) {
        const source = experiments.get(row.experimentId) ??
          experiments.get(identities.get(row.experimentId)?.canonicalExperimentId ?? "");
        if (
          source?.traceArtifactId !== undefined && artifactTombstones.has(source.traceArtifactId) ||
          source?.replayArtifactId !== undefined && artifactTombstones.has(source.replayArtifactId)
        ) return false;
      }
      return true;
    });
  },
);

export const liveCandidate = databaseSchema.anonymousView(
  { name: "live_candidate", public: true },
  t.array(candidate.rowType),
  (ctx) => {
    const tombstoneRows = [...ctx.db.tombstone.iter()];
    const candidateTombstones = new Set(
      tombstoneRows.filter((row) => row.targetKind === "candidate").map((row) => row.targetId),
    );
    const artifactTombstones = new Set(
      tombstoneRows.filter((row) => row.targetKind === "artifact").map((row) => row.targetId),
    );
    return [...ctx.db.candidate.iter()].filter(
      (row) => !candidateTombstones.has(row.id) && !artifactTombstones.has(row.sourceArtifactId),
    );
  },
);

export const revokedRecord = databaseSchema.anonymousView(
  { name: "revoked_record", public: true },
  t.array(t.row("RevokedRecord", {
    key: t.string().primaryKey(),
    targetKind: t.string(),
    targetId: t.string(),
    reason: t.string(),
    createdAtMs: t.i64(),
    investigationId: t.option(t.string()),
  })),
  (ctx) => {
    const findings = new Map([...ctx.db.finding.iter()].map((row) => [row.id, row]));
    const candidates = new Map([...ctx.db.candidate.iter()].map((row) => [row.id, row]));
    const evidenceRows = new Map([...ctx.db.evidence.iter()].map((row) => [row.id.toString(), row]));
    const experiments = [...ctx.db.experiment.iter()];
    const artifactEvidence = [...ctx.db.evidence.iter()];
    return [...ctx.db.tombstone.iter()].map((row) => {
      let investigationId: string | undefined;
      if (row.targetKind === "finding") {
        investigationId = findings.get(row.targetId)?.investigationId;
      } else if (row.targetKind === "candidate") {
        investigationId = candidates.get(row.targetId)?.investigationId;
      } else if (row.targetKind === "evidence") {
        const linked = evidenceRows.get(row.targetId);
        investigationId = linked === undefined ? undefined : findings.get(linked.findingId)?.investigationId;
      } else if (row.targetKind === "artifact") {
        const candidateRow = [...candidates.values()].find((candidateRow) => candidateRow.sourceArtifactId === row.targetId);
        investigationId = candidateRow?.investigationId;
        if (investigationId === undefined) {
          const experimentRow = experiments.find(
            (item) => item.traceArtifactId === row.targetId || item.replayArtifactId === row.targetId,
          );
          investigationId = experimentRow?.investigationId;
        }
        if (investigationId === undefined) {
          const linkedEvidence = artifactEvidence.find((item) => item.artifactId === row.targetId);
          investigationId = linkedEvidence === undefined
            ? undefined
            : findings.get(linkedEvidence.findingId)?.investigationId;
        }
      }
      return {
        key: row.key,
        targetKind: row.targetKind,
        targetId: row.targetId,
        reason: row.reason,
        createdAtMs: row.createdAtMs,
        investigationId,
      };
    });
  },
);

export default databaseSchema;
