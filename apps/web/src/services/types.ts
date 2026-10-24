import type {
  AgentSession,
  CandidateEvaluation,
  ControllerCandidate,
  ExperimentResult,
  Finding,
  HumanReview,
  IntegrationMode,
  IntegrationReadiness,
  Investigation,
  InvestigationEnvironment,
  ReviewDecision,
  SimCase,
  SimRunResult,
} from "@forksafe/contracts";

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
}

export type CaptureOutcome =
  | { accepted: true; investigationId: string }
  | { accepted: false; mode: IntegrationMode; reason: string };

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
  /** Invalidation stream; listeners re-fetch what they render. */
  subscribe(investigationId: string, onChange: () => void): () => void;
  getReadiness(): Promise<IntegrationReadiness[]>;
}

export type { SimCase };
