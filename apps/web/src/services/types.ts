import type {
  AgentSession,
  CandidateEvaluation,
  ControllerCandidate,
  ExperimentResult,
  Finding,
  HumanReview,
  IntegrationMode,
  Investigation,
  InvestigationEnvironment,
  ReviewDecision,
  SimFrame,
  SimCase,
  SimRunResult,
} from "@forksafe/contracts";

export type WebIntegrationReadiness = import("@forksafe/contracts").IntegrationReadiness & { probed: boolean };

/** Where the web app's data is coming from. Shown in the readiness strip. */
export interface DataSourceInfo {
  kind: "fixture" | "convex";
  mode: IntegrationMode;
  detail: string;
}

/** Restricted investigations are listed by title only; opening one is denied. */
export interface InvestigationListItem {
  id: string;
  title: string;
  state: Investigation["state"] | "restricted";
  requestedEnvironments?: number;
  updatedAtMs?: number;
}

/** Cancellation has a visible requested/pending phase (PRD). */
export type CancellationState = "none" | "requested" | "confirmed";

/** One investigation's lifecycle view (Convex-owned) joined with its
 *  evidence (SpacetimeDB-owned) by investigation/environment ids. */
export interface InvestigationWorkspace {
  investigation: Investigation;
  environments: InvestigationEnvironment[];
  sessions: AgentSession[];
  experiments: ExperimentResult[];
  candidates: ControllerCandidate[];
  evaluations: CandidateEvaluation[];
  reviews: HumanReview[];
  cancellation: CancellationState;
  /** Wall clock the data reflects; recorded fixtures are frozen in time. */
  asOfMs: number;
}

export interface ReviewInput {
  investigationId: string;
  candidateId: string;
  evaluationId: string;
  controllerSha256: string;
  decision: ReviewDecision;
  notes?: string;
}

export interface CaptureDraft {
  title: string;
  seed: number;
  sceneOverrides: Record<string, number>;
  requestedEnvironments: number;
  controller?: ControllerChoiceValue;
}

export type ControllerChoiceValue = "approved" | "baseline";

export interface LearningExperimentSummary {
  experimentId: string;
  status: string;
  completed: boolean;
  completionTimeSec?: number;
  firstFailure?: { kind: string; tSec: number; detail: string };
  replayArtifactId?: string;
  controllerSha256: string;
  failureKinds?: string[];
}

export interface LearningView {
  taskFamily: string;
  lineage: {
    version: number;
    controllerSha256: string;
    label: string;
    investigationId?: string;
    investigationTitle?: string;
    candidateId?: string;
    approvedAtMs?: number;
  }[];
  current: { version: number; controllerSha256: string } | null;
  thisRun: { controllerSha256: string | null; version: number | null; choice: ControllerChoiceValue | null };
  retry: {
    available: boolean;
    reason?: string;
    latest?: {
      investigationId: string;
      state: string;
      captureStatus: string | null;
      controllerSha256: string | null;
      controllerVersion: number | null;
      before: LearningExperimentSummary | null;
      after: LearningExperimentSummary | null;
      recorded?: boolean;
    };
  };
  priorHints: {
    findingId: string;
    sourceInvestigationId: string;
    sourceTitle: string;
    summary: string;
    used: boolean;
  }[];
}

export interface CurrentController {
  taskFamily: string;
  approved: { version: number; controllerSha256: string; investigationTitle?: string } | null;
  baseline: { version: 1; controllerSha256: string } | null;
}

export type CaptureOutcome =
  | { accepted: true; investigationId: string }
  | { accepted: false; mode: IntegrationMode; reason: string };

/** Pipeline counters for the health page (Convex-owned bookkeeping). */
export interface PipelineHealth {
  mode: IntegrationMode;
  checkedAtMs: number;
  activeSandboxes: number;
  sandboxCap: number;
  runners: number;
  outboxBacklog: number;
  outboxDead: number;
  oldestBacklogAtMs?: number;
}

export interface EvidenceCitation {
  id: string;
  docType: "finding" | "evidence" | "experiment_result";
  summary: string;
  environmentId?: string;
}

/** Answer from the Elastic evidence agent, scoped to one investigation. */
export interface EvidenceAnswer {
  mode: IntegrationMode;
  /** True only when the answer is backed by at least one validated citation. */
  enoughEvidence: boolean;
  answer?: string;
  label?: string;
  reason?: string;
  citations: EvidenceCitation[];
  /** Citations the agent used that failed validation (revoked, stale, out of scope...). */
  withheld: { id: string; reason: string }[];
}

export type HandoffStage =
  | "admission_reserved" | "grant_installed" | "work_started"
  | "artifacts_persisted" | "evidence_committed" | "completion_acknowledged";

/** One durable handoff step of a Convex job, for the timeline. */
export interface HandoffEvent {
  jobId: string;
  jobKind: string;
  environmentId?: string;
  stage: HandoffStage;
  atMs: number;
  stale: boolean;
}

export type LiveStreamStatus = "waiting" | "streaming" | "finished" | "unavailable";

export interface LiveStreamSnapshot {
  mode: "live" | "local" | "fixture";
  status: LiveStreamStatus;
  reason?: string;
  replayArtifactId?: string;
  chunks: { seq: number; final: boolean; frames: SimFrame[] }[];
}

export interface ForkSafeClient {
  readonly source: DataSourceInfo;
  listInvestigations(): Promise<InvestigationListItem[]>;
  getWorkspace(investigationId: string): Promise<InvestigationWorkspace>;
  /** Shared evidence feed for an investigation, newest first. */
  listFindings(investigationId: string): Promise<Finding[]>;
  getReplay(artifactId: string): Promise<SimRunResult>;
  getReplayForCandidate(candidateId: string): Promise<SimRunResult>;
  getCandidateDiff(candidateId: string): Promise<string>;
  cancelInvestigation(investigationId: string): Promise<void>;
  submitReview(input: ReviewInput): Promise<HumanReview>;
  requestCapture(draft: CaptureDraft): Promise<CaptureOutcome>;
  getLearning(investigationId: string): Promise<LearningView>;
  retryWithImprovedController(investigationId: string): Promise<CaptureOutcome>;
  getCurrentController(taskFamily?: string): Promise<CurrentController>;
  /** Invalidation stream; listeners re-fetch what they render. */
  subscribe(investigationId: string, onChange: () => void): () => void;
  watchLive(experimentId: string, onUpdate: (snapshot: LiveStreamSnapshot) => void): () => void;
  getReadiness(): Promise<WebIntegrationReadiness[]>;
  getPipelineHealth(): Promise<PipelineHealth>;
  /** Investigation-scoped question to the evidence agent; never affects scores. */
  askEvidence(investigationId: string, question: string): Promise<EvidenceAnswer>;
  listHandoffs(investigationId: string): Promise<HandoffEvent[]>;
}

export type { SimCase };
