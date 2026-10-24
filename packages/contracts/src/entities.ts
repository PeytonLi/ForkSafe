import { z } from "zod";
import {
  ArtifactId,
  AttemptId,
  CandidateId,
  EnvironmentId,
  EvaluationId,
  ExperimentId,
  FindingId,
  GrantId,
  InvestigationId,
  JobId,
  OperationId,
  OutboxId,
  ReviewId,
  SessionId,
  VendorRef,
} from "./ids.js";
import {
  ArtifactKind,
  AttemptState,
  CandidateStatus,
  EnvironmentState,
  EvaluationStatus,
  EvidenceKind,
  ExperimentStatus,
  FailureKind,
  FindingKind,
  IntegrationMode,
  InvestigationState,
  JobKind,
  JobState,
  OutboxDestination,
  OutboxStatus,
  ReviewDecision,
  SessionState,
} from "./enums.js";

/** Simulation contract constants (PRD). */
export const SIM = {
  timestepSec: 0.002,
  controlPeriodSec: 0.01,
  viewerSampleHz: 10,
  timeoutSec: 30,
  completionRadiusM: 0.03,
  settleDurationSec: 0.5,
  penetrationLimitM: 0.001,
  penetrationConsecutiveSteps: 5,
  graspAttachDistanceM: 0.02,
} as const;

export const SimCase = z.object({
  caseId: z.string().min(1),
  suite: z.enum(["original", "public", "withheld"]),
  seed: z.number().int().nonnegative(),
  sceneOverrides: z.record(z.number()).default({}),
  taskFamily: z.string().optional(),
  description: z.string().optional(),
});
export type SimCase = z.infer<typeof SimCase>;

export const Investigation = z.object({
  id: InvestigationId,
  state: InvestigationState,
  title: z.string().min(1),
  // The baseline captured failure this investigation reproduces.
  baselineCase: SimCase,
  baselineExperimentId: ExperimentId,
  jiraIssueKey: z.string().optional(), // vendor ref, not an application id
  confluencePageId: z.string().optional(),
  requestedEnvironments: z.number().int().min(1).max(10),
  captureStatus: z.enum(["pending", "running", "recorded", "failed"]).optional(),
  lastError: z.string().optional(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
});
export type Investigation = z.infer<typeof Investigation>;

export const InvestigationEnvironment = z.object({
  id: EnvironmentId,
  investigationId: InvestigationId,
  index: z.number().int().nonnegative(), // environment slot, stable
  state: EnvironmentState,
  daytonaSandbox: VendorRef.optional(), // trusted runner sandbox
  budgets: z.object({
    maxExperiments: z.number().int().default(20),
    maxCandidates: z.number().int().default(2),
    maxFactorySessions: z.number().int().default(2),
    wallTimeMs: z.number().int().default(10 * 60 * 1000),
  }),
  startedAtMs: z.number().int().optional(),
  closedAtMs: z.number().int().optional(),
});
export type InvestigationEnvironment = z.infer<typeof InvestigationEnvironment>;

export const Job = z.object({
  id: JobId,
  kind: JobKind,
  state: JobState,
  investigationId: InvestigationId,
  environmentId: EnvironmentId.optional(),
  /** Current fencing epoch. Incremented on retry/lease takeover. */
  epoch: z.number().int().nonnegative(),
  activeAttemptId: AttemptId.optional(),
  idempotencyKey: z.string().min(8), // durable cross-service dedupe
  payload: z.record(z.unknown()),
  attemptsUsed: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(2), // one infra retry
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
});
export type Job = z.infer<typeof Job>;

export const Attempt = z.object({
  id: AttemptId,
  jobId: JobId,
  epoch: z.number().int().nonnegative(),
  state: AttemptState,
  workerId: z.string().min(1),
  leasedUntilMs: z.number().int(),
  lastHeartbeatMs: z.number().int(),
  startedAtMs: z.number().int(),
  endedAtMs: z.number().int().optional(),
});
export type Attempt = z.infer<typeof Attempt>;

/** Bounded execution grant Convex installs in SpacetimeDB for a worker.
 *  The worker may only act while grantExpiryMs is in the future and the
 *  attempt/epoch still matches the job record in Convex. */
export const ExecutionGrant = z.object({
  id: GrantId,
  jobId: JobId,
  attemptId: AttemptId,
  epoch: z.number().int().nonnegative(),
  investigationId: InvestigationId,
  environmentId: EnvironmentId.optional(),
  scope: z.object({
    operations: z.array(z.string().min(1)), // reducer op names permitted
    artifactPrefixes: z.array(z.string()),
    maxBytes: z.number().int().nonnegative(),
  }),
  expiresAtMs: z.number().int(),
  revokedAtMs: z.number().int().optional(),
});
export type ExecutionGrant = z.infer<typeof ExecutionGrant>;

/** Controller revision write lease (SpacetimeDB authority). */
export const RevisionLease = z.object({
  environmentId: EnvironmentId,
  holderAttemptId: AttemptId,
  grantId: GrantId,
  renewedAtMs: z.number().int(),
  expiresAtMs: z.number().int(),
});
export type RevisionLease = z.infer<typeof RevisionLease>;

/** Factory session bound to one environment. */
export const AgentSession = z.object({
  id: SessionId,
  investigationId: InvestigationId,
  environmentId: EnvironmentId,
  state: SessionState,
  factorySession: VendorRef.optional(),
  model: z.string().optional(),
  mode: IntegrationMode,
  tokenUsage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().default(0),
    cacheCreationTokens: z.number().int().nonnegative().default(0),
    /** null/unknown usage is reported, never counted as zero. */
    usageKnown: z.boolean(),
    factoryCredits: z.number().nonnegative().optional(),
  }),
  createdAtMs: z.number().int(),
  closedAtMs: z.number().int().optional(),
});
export type AgentSession = z.infer<typeof AgentSession>;

export const ExperimentResult = z.object({
  id: ExperimentId,
  investigationId: InvestigationId,
  environmentId: EnvironmentId.optional(), // absent for evaluator runs
  candidateId: CandidateId.optional(),
  attemptId: AttemptId,
  epoch: z.number().int().nonnegative(),
  simCase: SimCase,
  status: ExperimentStatus,
  failureKinds: z.array(FailureKind).default([]),
  completed: z.boolean(),
  completionTimeSec: z.number().nonnegative().optional(),
  changedFunctions: z.array(z.string()).default([]), // vs baseline controller
  traceArtifactId: ArtifactId.optional(),
  replayArtifactId: ArtifactId.optional(),
  engineVersion: z.string(), // mujoco.__version__
  assetsSha256: z.string().length(64),
  controllerSha256: z.string().length(64),
  startedAtMs: z.number().int(),
  finishedAtMs: z.number().int().optional(),
});
export type ExperimentResult = z.infer<typeof ExperimentResult>;

export const Finding = z.object({
  id: FindingId,
  investigationId: InvestigationId,
  environmentId: EnvironmentId, // provenance: who found it
  sessionId: SessionId.optional(),
  kind: FindingKind,
  summary: z.string().min(1),
  evidence: z.array(
    z.object({
      kind: EvidenceKind,
      artifactId: ArtifactId.optional(),
      experimentId: ExperimentId.optional(),
      /** deterministic locator: frame range, contact pair, code span */
      locator: z.record(z.unknown()).default({}),
      excerpt: z.string().max(4000).optional(),
    }),
  ),
  createdAtMs: z.number().int(),
});
export type Finding = z.infer<typeof Finding>;

export const ControllerCandidate = z.object({
  id: CandidateId,
  investigationId: InvestigationId,
  environmentId: EnvironmentId,
  status: CandidateStatus,
  controllerSha256: z.string().length(64),
  sourceArtifactId: ArtifactId,
  changedFunctions: z.array(z.string()),
  rationale: z.string().max(4000).optional(),
  basedOnFindings: z.array(FindingId).default([]),
  submittedByAttemptId: AttemptId,
  submittedAtMs: z.number().int(),
});
export type ControllerCandidate = z.infer<typeof ControllerCandidate>;

export const CaseEvaluation = z.object({
  caseId: z.string(),
  status: EvaluationStatus,
  experimentId: ExperimentId.optional(),
  completionTimeSec: z.number().nonnegative().optional(),
  failureKinds: z.array(FailureKind).default([]),
});
export type CaseEvaluation = z.infer<typeof CaseEvaluation>;

export const CandidateEvaluation = z.object({
  id: EvaluationId,
  candidateId: CandidateId,
  investigationId: InvestigationId,
  evaluatorAttemptId: AttemptId, // protected evaluator worker
  suite: z.enum(["public", "withheld"]),
  cases: z.array(CaseEvaluation),
  allRequiredPassed: z.boolean(),
  medianCompletionTimeSec: z.number().nonnegative().optional(),
  status: EvaluationStatus,
  reportArtifactId: ArtifactId.optional(),
  createdAtMs: z.number().int(),
});
export type CandidateEvaluation = z.infer<typeof CandidateEvaluation>;

export const HumanReview = z.object({
  id: ReviewId,
  investigationId: InvestigationId,
  candidateId: CandidateId,
  evaluationId: EvaluationId,
  /** Exact immutable controller version reviewed. */
  controllerSha256: z.string().length(64),
  decision: ReviewDecision,
  reviewerIdentity: z.string(), // Atlassian account id or local identity
  notes: z.string().max(4000).optional(),
  jiraIssueKey: z.string().optional(),
  createdAtMs: z.number().int(),
});
export type HumanReview = z.infer<typeof HumanReview>;

export const ArtifactRef = z.object({
  id: ArtifactId,
  kind: ArtifactKind,
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  storage: z.enum(["convex", "local_fs"]),
  /** Storage-side key; authorized through a grant, not guessable. */
  storageKey: z.string().min(1),
  producedByAttemptId: AttemptId.optional(),
  createdAtMs: z.number().int(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const OutboxEntry = z.object({
  id: OutboxId,
  destination: OutboxDestination,
  status: OutboxStatus,
  idempotencyKey: z.string().min(8),
  operationId: OperationId,
  payload: z.record(z.unknown()),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
  createdAtMs: z.number().int(),
  deliveredAtMs: z.number().int().optional(),
});
export type OutboxEntry = z.infer<typeof OutboxEntry>;

export const IntegrationReadiness = z.object({
  name: z.enum([
    "convex",
    "spacetimedb",
    "daytona",
    "factory",
    "elastic",
    "elastic_agent_builder",
    "atlassian_jira",
    "atlassian_confluence",
    "artifact_store",
    "simulator",
    "evaluator",
  ]),
  mode: IntegrationMode,
  detail: z.string().max(1000).optional(),
  checkedAtMs: z.number().int(),
});
export type IntegrationReadiness = z.infer<typeof IntegrationReadiness>;
