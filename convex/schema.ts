import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const uuid = v.string();
const vendorRef = v.object({ provider: v.string(), id: v.string() });
const simCase = v.object({
  caseId: v.string(),
  suite: v.union(v.literal("original"), v.literal("public"), v.literal("withheld")),
  seed: v.number(),
  sceneOverrides: v.record(v.string(), v.number()),
  description: v.optional(v.string()),
});
const resources = v.object({ cpu: v.number(), memoryGiB: v.number(), diskGiB: v.number() });
const pendingRevocation = v.object({
  attemptId: uuid,
  grantId: v.optional(uuid),
  epoch: v.number(),
  grantExpiresAtMs: v.number(),
});
const attemptState = v.union(
  v.literal("leased"), v.literal("heartbeating"), v.literal("completing"),
  v.literal("succeeded"), v.literal("failed"), v.literal("expired"), v.literal("fenced"),
);

export default defineSchema({
  ...authTables,
  forgeRequests: defineTable({
    idempotencyKey: v.string(), payload: v.string(), requestId: uuid,
    parentInvestigationId: uuid, followUpInvestigationId: uuid,
    requestedBy: v.string(), note: v.string(), extraEnvironments: v.number(),
    installationId: v.string(), createdAtMs: v.number(),
    result: v.object({ requestId: uuid, accepted: v.boolean(), state: v.literal("admitted") }),
  }).index("by_idempotencyKey", ["idempotencyKey"]),
  readinessSnapshots: defineTable({
    key: v.string(),
    checkedAtMs: v.number(),
    leaseUntilMs: v.number(),
    integrations: v.any(),
  }).index("by_key", ["key"]),
  investigations: defineTable({
    parentInvestigationId: v.optional(uuid),
    appId: uuid,
    title: v.string(),
    state: v.union(
      v.literal("capturing"), v.literal("admitted"), v.literal("searching"),
      v.literal("evaluating"), v.literal("awaiting_review"), v.literal("completed"),
      v.literal("cancelled"), v.literal("failed"),
    ),
    cancelStatus: v.union(v.literal("none"), v.literal("cancel_requested"), v.literal("cancelled")),
    cancelEpoch: v.number(),
    version: v.number(),
    requestedEnvironments: v.number(),
    baselineCase: simCase,
    baselineExperimentId: uuid,
    jiraIssueKey: v.optional(v.string()),
    budget: v.object({
      wallTimeMs: v.number(),
      maxExperimentsPerEnv: v.number(),
      maxCandidatesPerEnv: v.number(),
      maxFinalCandidates: v.number(),
    }),
    idempotencyKey: v.string(),
    workflowId: v.optional(v.string()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
    startedAtMs: v.optional(v.number()),
    finishedAtMs: v.optional(v.number()),
    lastError: v.optional(v.string()),
    captureStatus: v.optional(v.union(v.literal("pending"), v.literal("running"), v.literal("recorded"), v.literal("failed"))),
    autoStart: v.optional(v.boolean()),
  }).index("by_appId", ["appId"]).index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_state", ["state"]).index("by_cancel_status", ["cancelStatus"]),

  environments: defineTable({
    appId: uuid,
    investigationId: uuid,
    index: v.number(),
    state: v.union(
      v.literal("provisioning"), v.literal("active"), v.literal("paused"),
      v.literal("closing"), v.literal("closed"), v.literal("error"),
    ),
    daytonaSandbox: v.optional(vendorRef),
    budgets: v.object({
      maxExperiments: v.number(),
      maxCandidates: v.number(),
      maxFactorySessions: v.number(),
      wallTimeMs: v.number(),
    }),
    startedAtMs: v.optional(v.number()),
    closedAtMs: v.optional(v.number()),
    experimentsUsed: v.number(),
    candidatesUsed: v.number(),
    runnerCredentialId: v.optional(uuid),
    runnerSandboxOpId: v.optional(uuid),
    lastError: v.optional(v.string()),
  }).index("by_appId", ["appId"]).index("by_investigation", ["investigationId"]),

  jobs: defineTable({
    appId: uuid,
    kind: v.union(
      v.literal("provision_sandbox"), v.literal("factory_session"), v.literal("run_experiment"),
      v.literal("submit_candidate"), v.literal("evaluate_candidate"), v.literal("elastic_index"),
      v.literal("jira_sync"), v.literal("cleanup"),
    ),
    state: v.union(
      v.literal("reserved"), v.literal("grant_pending"), v.literal("granted"), v.literal("running"),
      v.literal("artifacts_pending"), v.literal("evidence_pending"), v.literal("acknowledged"),
      v.literal("succeeded"), v.literal("failed"), v.literal("cancelled"),
    ),
    investigationId: uuid,
    environmentId: v.optional(uuid),
    epoch: v.number(),
    activeAttemptId: v.optional(uuid),
    idempotencyKey: v.string(),
    payload: v.any(),
    attemptsUsed: v.number(),
    maxAttempts: v.number(),
    operationId: uuid,
    admittedCancelEpoch: v.number(),
    dependsOn: v.array(uuid),
    leaseExpiresAtMs: v.optional(v.number()),
    workerId: v.optional(v.string()),
    cancelRequestedAtMs: v.optional(v.number()),
    pendingRevocation: v.optional(pendingRevocation),
    lastError: v.optional(v.string()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_state", ["state"])
    .index("by_investigation", ["investigationId"]).index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_kind_state", ["kind", "state"]),

  attempts: defineTable({
    appId: uuid,
    jobId: uuid,
    epoch: v.number(),
    state: attemptState,
    workerId: v.string(),
    leasedUntilMs: v.number(),
    lastHeartbeatMs: v.number(),
    startedAtMs: v.number(),
    endedAtMs: v.optional(v.number()),
    grantId: v.optional(uuid),
    grantExpiresAtMs: v.optional(v.number()),
    grantRevokedAtMs: v.optional(v.number()),
    outcome: v.optional(v.string()),
  }).index("by_appId", ["appId"]).index("by_job", ["jobId"]),

  handoffs: defineTable({
    operationId: uuid,
    jobId: uuid,
    stage: v.union(
      v.literal("admission_reserved"), v.literal("grant_installed"), v.literal("work_started"),
      v.literal("artifacts_persisted"), v.literal("evidence_committed"), v.literal("completion_acknowledged"),
    ),
    attemptId: v.optional(uuid),
    grantId: v.optional(uuid),
    detail: v.any(),
    atMs: v.number(),
    epoch: v.number(),
    stale: v.boolean(),
  }).index("by_operation", ["operationId"]).index("by_job", ["jobId"]),

  reservations: defineTable({
    appId: uuid,
    kind: v.union(v.literal("environment_job"), v.literal("sandbox"), v.literal("model_turn")),
    status: v.union(
      v.literal("active"), v.literal("released"), v.literal("retained_ambiguous"), v.literal("expired"),
    ),
    investigationId: uuid,
    environmentId: v.optional(uuid),
    holder: v.object({
      jobId: v.optional(uuid),
      attemptId: v.optional(uuid),
      sessionId: v.optional(uuid),
      sandboxOpId: v.optional(uuid),
    }),
    operationId: uuid,
    leasedUntilMs: v.optional(v.number()),
    createdAtMs: v.number(),
    releasedAtMs: v.optional(v.number()),
    releaseReason: v.optional(v.string()),
  }).index("by_kind_status", ["kind", "status"])
    .index("by_investigation", ["investigationId"]).index("by_operation", ["operationId"]),

  sandboxOps: defineTable({
    appId: uuid,
    purpose: v.union(v.literal("runner"), v.literal("execution"), v.literal("evaluator"), v.literal("bridge")),
    investigationId: uuid,
    environmentId: v.optional(uuid),
    jobId: v.optional(uuid),
    attemptId: v.optional(uuid),
    snapshot: v.string(),
    resources,
    provider: v.union(v.literal("daytona"), v.literal("local")),
    sandbox: v.optional(vendorRef),
    status: v.union(
      v.literal("requested"), v.literal("creating"), v.literal("ready"), v.literal("ambiguous_create"),
      v.literal("terminating"), v.literal("ambiguous_terminate"), v.literal("terminated"), v.literal("error"),
    ),
    reservationId: uuid,
    reservedSandboxCount: v.optional(v.number()),
    bundleSha256: v.optional(v.string()),
    lastError: v.optional(v.string()),
    attempts: v.number(),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
    terminatedAtMs: v.optional(v.number()),
  }).index("by_appId", ["appId"]).index("by_status", ["status"]).index("by_investigation", ["investigationId"]),

  sandboxCommands: defineTable({
    appId: uuid,
    sandboxOpId: uuid,
    jobId: uuid,
    attemptId: uuid,
    epoch: v.number(),
    command: v.string(),
    status: v.union(
      v.literal("starting"), v.literal("running"), v.literal("exited"),
      v.literal("failed"), v.literal("lost"),
    ),
    exitCode: v.optional(v.number()),
    handle: v.optional(v.object({ sessionId: v.string(), commandId: v.string() })),
    logTail: v.string(),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_sandboxOp", ["sandboxOpId"]),

  artifacts: defineTable({
    evidencePack: v.optional(v.boolean()),
    appId: uuid,
    kind: v.union(
      v.literal("trace"), v.literal("replay"), v.literal("controller_source"),
      v.literal("log"), v.literal("report"), v.literal("screenshot"),
    ),
    sha256: v.string(),
    bytes: v.number(),
    storage: v.union(v.literal("convex"), v.literal("local_fs")),
    storageKey: v.string(),
    producedByAttemptId: v.optional(uuid),
    createdAtMs: v.number(),
    investigationId: uuid,
    visibility: v.union(v.literal("internal"), v.literal("withheld")),
    storageId: v.optional(v.id("_storage")),
    chunk: v.optional(v.object({ index: v.number(), total: v.number(), groupSha256: v.string() })),
    revokedAtMs: v.optional(v.number()),
  }).index("by_appId", ["appId"]).index("by_sha_investigation", ["sha256", "investigationId"]).index("by_investigation", ["investigationId"]),

  outbox: defineTable({
    appId: uuid,
    destination: v.union(v.literal("elastic_index"), v.literal("jira_sync"), v.literal("confluence_link")),
    status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("dead")),
    idempotencyKey: v.string(),
    operationId: uuid,
    payload: v.any(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    createdAtMs: v.number(),
    deliveredAtMs: v.optional(v.number()),
    source: v.union(v.literal("convex"), v.literal("spacetimedb")),
    nextAttemptAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_status_next", ["status", "nextAttemptAtMs"]).index("by_idempotencyKey", ["idempotencyKey"]),

  systemFlags: defineTable({
    key: v.literal("global"),
    admissionPaused: v.boolean(),
    pausedReason: v.optional(v.string()),
    bridgeLastHealthyAtMs: v.optional(v.number()),
    bridgeIdentity: v.optional(v.string()),
    bridgeRegisteredAtMs: v.optional(v.number()),
    bridgeLastError: v.optional(v.string()),
    bridgeToken: v.optional(v.string()),
    bridgeMode: v.optional(v.string()),
  }).index("by_key", ["key"]),

  /** Uploaded code bundles the orchestrator ships into sandboxes
   *  (runner bundle, simulator bundle, baseline controller). */
  bundles: defineTable({
    key: v.union(v.literal("runner"), v.literal("simulator"), v.literal("baseline_controller")),
    storageId: v.id("_storage"),
    sha256: v.string(),
    bytes: v.number(),
    uploadedAtMs: v.number(),
    note: v.optional(v.string()),
  }).index("by_key", ["key"]),

  /** Scoped, expiring HMAC credential handed to exactly one runner sandbox.
   *  Never the deploy key or the bridge secret. */
  runnerCredentials: defineTable({
    appId: uuid,
    investigationId: uuid,
    environmentId: uuid,
    sandboxOpId: v.optional(uuid),
    secret: v.string(),
    expiresAtMs: v.number(),
    revokedAtMs: v.optional(v.number()),
    revokeReason: v.optional(v.string()),
    createdAtMs: v.number(),
    lastSeenAtMs: v.optional(v.number()),
    workerId: v.optional(v.string()),
  }).index("by_appId", ["appId"]).index("by_environment", ["environmentId"])
    .index("by_investigation", ["investigationId"]),

  /** Execution grants Convex installed in SpacetimeDB, one per attempt+epoch. */
  grants: defineTable({
    appId: uuid,
    jobId: uuid,
    attemptId: uuid,
    epoch: v.number(),
    investigationId: uuid,
    environmentId: v.optional(uuid),
    scope: v.object({
      operations: v.array(v.string()),
      artifactPrefixes: v.array(v.string()),
      maxBytes: v.number(),
    }),
    expiresAtMs: v.number(),
    revokedAtMs: v.optional(v.number()),
    revokeReason: v.optional(v.string()),
    bridgeMode: v.union(v.literal("live"), v.literal("local"), v.literal("fixture"), v.literal("blocked"), v.literal("not_implemented")),
    installedAtMs: v.optional(v.number()),
    spacetimeInstalled: v.boolean(),
    spacetimeRevoked: v.boolean(),
    lastError: v.optional(v.string()),
    createdAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_attempt", ["attemptId"]).index("by_job", ["jobId"])
    .index("by_pending_revoke", ["spacetimeRevoked", "revokedAtMs"]),

  /** Bridge projection of Factory sessions reported by trusted runners. */
  sessions: defineTable({
    appId: uuid,
    investigationId: uuid,
    environmentId: uuid,
    attemptId: v.optional(uuid),
    state: v.union(
      v.literal("created"), v.literal("streaming"), v.literal("idle"),
      v.literal("budget_exhausted"), v.literal("closed"), v.literal("error"),
    ),
    factorySession: v.optional(vendorRef),
    model: v.optional(v.string()),
    mode: v.union(v.literal("live"), v.literal("local"), v.literal("fixture"), v.literal("blocked"), v.literal("not_implemented")),
    tokenUsage: v.object({
      inputTokens: v.number(),
      outputTokens: v.number(),
      cacheReadTokens: v.number(),
      cacheCreationTokens: v.number(),
      usageKnown: v.boolean(),
      factoryCredits: v.optional(v.number()),
    }),
    turns: v.optional(v.number()),
    createdAtMs: v.number(),
    closedAtMs: v.optional(v.number()),
    updatedAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_investigation", ["investigationId"])
    .index("by_environment", ["environmentId"]),

  /** Bridge projection of experiments (development + evaluator runs). */
  experiments: defineTable({
    appId: uuid,
    investigationId: uuid,
    environmentId: v.optional(uuid),
    candidateId: v.optional(uuid),
    revisionId: v.optional(uuid),
    attemptId: uuid,
    epoch: v.number(),
    grantId: v.optional(uuid),
    purpose: v.union(v.literal("baseline"), v.literal("development"), v.literal("evaluation")),
    suite: v.union(v.literal("original"), v.literal("public"), v.literal("withheld")),
    simCase: simCase,
    status: v.union(
      v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("physics_failure"),
      v.literal("constraint_violation"), v.literal("engine_error"), v.literal("invalid"), v.literal("cancelled"),
    ),
    failureKinds: v.array(v.string()),
    completed: v.boolean(),
    completionTimeSec: v.optional(v.number()),
    firstFailure: v.optional(v.object({ kind: v.string(), tSec: v.number(), detail: v.string() })),
    changedFunctions: v.array(v.string()),
    traceArtifactId: v.optional(uuid),
    replayArtifactId: v.optional(uuid),
    engineVersion: v.string(),
    assetsSha256: v.string(),
    controllerSha256: v.string(),
    hypothesis: v.optional(v.string()),
    sandboxOpId: v.optional(uuid),
    spacetimeCommitted: v.boolean(),
    startedAtMs: v.number(),
    finishedAtMs: v.optional(v.number()),
  }).index("by_appId", ["appId"]).index("by_investigation", ["investigationId"])
    .index("by_environment", ["environmentId"]).index("by_candidate", ["candidateId"]),

  /** Compact replay payloads (SimRunResult shape) readable by queries. */
  replays: defineTable({
    artifactId: uuid,
    experimentId: uuid,
    investigationId: uuid,
    visibility: v.union(v.literal("internal"), v.literal("withheld")),
    result: v.any(),
    truncatedFrames: v.boolean(),
    createdAtMs: v.number(),
  }).index("by_artifact", ["artifactId"]).index("by_experiment", ["experimentId"]),

  /** Bridge projection of SpacetimeDB findings. */
  findings: defineTable({
    appId: uuid,
    investigationId: uuid,
    environmentId: uuid,
    sessionId: v.optional(uuid),
    attemptId: uuid,
    epoch: v.number(),
    grantId: v.optional(uuid),
    kind: v.union(
      v.literal("collision_frame"), v.literal("limit_violation"), v.literal("behavioral_note"),
      v.literal("candidate_hypothesis"), v.literal("cross_environment_pattern"),
    ),
    claim: v.union(v.literal("observation"), v.literal("inference")),
    summary: v.string(),
    evidence: v.array(v.object({
      kind: v.union(
        v.literal("trace_frame"), v.literal("contact_event"), v.literal("metric"),
        v.literal("log_excerpt"), v.literal("code_diff"), v.literal("replay_segment"),
      ),
      artifactId: v.optional(uuid),
      experimentId: v.optional(uuid),
      locator: v.any(),
      excerpt: v.optional(v.string()),
    })),
    spacetimeCommitted: v.boolean(),
    createdAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_investigation", ["investigationId"])
    .index("by_environment", ["environmentId"]),

  /** Immutable controller revisions committed under a revision lease. */
  controllerRevisions: defineTable({
    appId: uuid,
    investigationId: uuid,
    environmentId: uuid,
    seq: v.number(),
    parentRevisionId: v.optional(uuid),
    controllerSha256: v.string(),
    sourceArtifactId: uuid,
    changedFunctions: v.array(v.string()),
    rationale: v.optional(v.string()),
    basedOnFindings: v.optional(v.array(uuid)),
    createdByAttemptId: uuid,
    epoch: v.number(),
    grantId: v.optional(uuid),
    spacetimeCommitted: v.boolean(),
    createdAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_environment", ["environmentId"])
    .index("by_investigation", ["investigationId"]).index("by_sha", ["controllerSha256"]),

  /** Controller source text, keyed by sha256 (immutable, content-addressed). */
  controllerSources: defineTable({
    controllerSha256: v.string(),
    investigationId: v.optional(uuid),
    artifactId: uuid,
    source: v.string(),
    bytes: v.number(),
    createdAtMs: v.number(),
  }).index("by_sha", ["controllerSha256"]),

  /** Bridge projection of immutable candidates. */
  candidates: defineTable({
    appId: uuid,
    investigationId: uuid,
    environmentId: uuid,
    revisionId: v.optional(uuid),
    status: v.union(
      v.literal("submitted"), v.literal("evaluating"), v.literal("evaluated"),
      v.literal("rejected"), v.literal("withdrawn"),
    ),
    controllerSha256: v.string(),
    sourceArtifactId: uuid,
    changedFunctions: v.array(v.string()),
    rationale: v.optional(v.string()),
    basedOnFindings: v.array(uuid),
    submittedByAttemptId: uuid,
    epoch: v.number(),
    grantId: v.optional(uuid),
    finalist: v.optional(v.boolean()),
    rank: v.optional(v.number()),
    spacetimeCommitted: v.boolean(),
    submittedAtMs: v.number(),
    updatedAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_investigation", ["investigationId"])
    .index("by_environment", ["environmentId"]),

  /** Immutable evaluations written by the protected evaluator. */
  evaluations: defineTable({
    appId: uuid,
    candidateId: uuid,
    investigationId: uuid,
    evaluatorAttemptId: uuid,
    jobId: v.optional(uuid),
    epoch: v.number(),
    grantId: v.optional(uuid),
    suite: v.union(v.literal("public"), v.literal("withheld")),
    cases: v.array(v.object({
      caseId: v.string(),
      status: v.union(v.literal("queued"), v.literal("running"), v.literal("passed"), v.literal("failed"), v.literal("invalid")),
      experimentId: v.optional(uuid),
      completionTimeSec: v.optional(v.number()),
      failureKinds: v.array(v.string()),
    })),
    allRequiredPassed: v.boolean(),
    medianCompletionTimeSec: v.optional(v.number()),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("passed"), v.literal("failed"), v.literal("invalid")),
    reportArtifactId: v.optional(uuid),
    sandboxOpId: v.optional(uuid),
    spacetimeCommitted: v.boolean(),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_candidate", ["candidateId"])
    .index("by_investigation", ["investigationId"]),

  /** Human reviews bound to the exact controller sha. */
  reviews: defineTable({
    appId: uuid,
    investigationId: uuid,
    candidateId: uuid,
    evaluationId: uuid,
    controllerSha256: v.string(),
    decision: v.union(v.literal("approved"), v.literal("rejected"), v.literal("needs_changes")),
    reviewerIdentity: v.string(),
    notes: v.optional(v.string()),
    jiraIssueKey: v.optional(v.string()),
    idempotencyKey: v.string(),
    spacetimeCommitted: v.boolean(),
    createdAtMs: v.number(),
  }).index("by_appId", ["appId"]).index("by_investigation", ["investigationId"])
    .index("by_idempotencyKey", ["idempotencyKey"]),

  agentToolCalls: defineTable({
    investigationId: uuid, environmentId: uuid, sessionId: uuid, attemptId: uuid, epoch: v.number(),
    tool: v.string(), callId: uuid, result: v.any(), atMs: v.number(),
  }).index("by_callId", ["callId"]).index("by_environment_tool", ["environmentId", "tool"]),

  findingReads: defineTable({
    investigationId: uuid, environmentId: uuid, sessionId: uuid, findingId: uuid, atMs: v.number(),
  }).index("by_environment_finding", ["environmentId", "findingId"])
    .index("by_investigation", ["investigationId"]),

  findingUses: defineTable({
    appId: uuid, findingId: uuid, findingEnvironmentId: uuid, usedByEnvironmentId: uuid,
    experimentId: v.optional(uuid), candidateId: v.optional(uuid), crossEnvironment: v.boolean(),
    spacetimeCommitted: v.boolean(), createdAtMs: v.number(),
  }).index("by_target", ["findingId", "experimentId", "candidateId"])
    .index("by_finding", ["findingId"]),

  sessionCheckpoints: defineTable({
    investigationId: uuid, environmentId: uuid, jobId: uuid, attemptId: uuid, epoch: v.number(),
    role: v.union(v.literal("primary"), v.literal("subtask")),
    sessionId: uuid, parentSessionId: v.optional(uuid), vendorSessionId: v.string(), turnIndex: v.number(),
    revisionHeadId: v.optional(uuid), tokenUsage: v.optional(v.any()), createdAtMs: v.number(),
  }).index("by_session_turn", ["sessionId", "turnIndex"])
    .index("by_environment_job", ["environmentId", "jobId"]),
});
