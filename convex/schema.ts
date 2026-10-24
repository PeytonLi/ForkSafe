import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
  investigations: defineTable({
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
  }).index("by_appId", ["appId"]).index("by_sha_investigation", ["sha256", "investigationId"]),

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
  }).index("by_key", ["key"]),
});
