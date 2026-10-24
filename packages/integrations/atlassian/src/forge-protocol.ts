import {
  CandidateEvaluation,
  CandidateId,
  ControllerCandidate,
  ArtifactId,
  EnvironmentId,
  EvaluationId,
  EvaluationStatus,
  EvidenceKind,
  ExperimentId,
  FindingId,
  FindingKind,
  HumanReview,
  IntegrationMode,
  IntegrationReadiness,
  Investigation,
  InvestigationEnvironment,
  InvestigationId,
  InvestigationState,
  ReviewId,
} from "@forksafe/contracts";
import { z } from "zod";

export const FORGE_BACKEND_PATHS = {
  panel: "/forge/v1/panel",
  start: "/forge/v1/investigations",
  reviewContext: "/forge/v1/review-context",
  review: "/forge/v1/reviews",
} as const;

export const FORGE_FEATURE_PATHS = {
  requests: "/forge/v1/requests",
} as const;

export const PanelRequest = z.object({
  issueKey: z.string().min(1),
  issueId: z.string().min(1),
  projectKey: z.string().min(1),
});
export type PanelRequest = z.infer<typeof PanelRequest>;

const HttpsUrl = z.string().url().refine((value) => value.startsWith("https://"));

const PanelInvestigation = Investigation.pick({
  id: true,
  state: true,
  title: true,
  requestedEnvironments: true,
  confluencePageId: true,
  updatedAtMs: true,
});

const PanelEnvironment = InvestigationEnvironment.pick({
  id: true,
  index: true,
  state: true,
});

export const SuiteSummary = z.object({
  evaluationId: EvaluationId,
  suite: z.enum(["public", "withheld"]),
  status: EvaluationStatus,
  allRequiredPassed: z.boolean(),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative(),
  failedCaseIds: z.array(z.string()).max(50).optional(),
});
export type SuiteSummary = z.infer<typeof SuiteSummary>;

export const FindingSummary = z.object({
  id: FindingId,
  kind: FindingKind,
  summary: z.string().max(500),
  environmentId: EnvironmentId,
  citations: z.array(z.object({
    kind: EvidenceKind,
    artifactId: ArtifactId.optional(),
    experimentId: ExperimentId.optional(),
  })).max(10),
});
export type FindingSummary = z.infer<typeof FindingSummary>;

export const PanelData = z.object({
  mode: IntegrationMode,
  issue: z.object({ key: z.string(), id: z.string() }),
  readiness: IntegrationReadiness.array(),
  investigation: PanelInvestigation.nullable(),
  environments: PanelEnvironment.array(),
  findingsCount: z.number().int().nonnegative(),
  findings: z.array(FindingSummary).max(25).optional(),
  candidates: z.array(
    z.object({
      candidate: ControllerCandidate.pick({
        id: true,
        environmentId: true,
        status: true,
        controllerSha256: true,
        changedFunctions: true,
        submittedAtMs: true,
      }),
      evaluation: CandidateEvaluation.pick({
        id: true,
        suite: true,
        status: true,
        allRequiredPassed: true,
        medianCompletionTimeSec: true,
      }).nullable(),
      passedCases: z.number().int().nonnegative(),
      totalCases: z.number().int().nonnegative(),
      suites: z.array(SuiteSummary).optional(),
    }),
  ),
  underReview: z
    .object({
      candidateId: CandidateId,
      evaluationId: EvaluationId,
      controllerSha256: z.string().length(64),
    })
    .nullable(),
  reviews: HumanReview.pick({
    id: true,
    candidateId: true,
    controllerSha256: true,
    decision: true,
    reviewerIdentity: true,
    createdAtMs: true,
  }).array(),
  requirements: z
    .object({
      pageId: z.string(),
      version: z.number().int().nonnegative(),
      title: z.string(),
      checkedRules: z.number().int().nonnegative(),
      humanReviewItems: z.number().int().nonnegative(),
    })
    .nullable(),
  links: z.object({
    investigationUrl: z.string().url().optional(),
    reportUrl: z.string().url().optional(),
    webAppUrl: HttpsUrl.optional(),
    evidencePackUrl: HttpsUrl.optional(),
  }),
  fetchedAtMs: z.number().int(),
});
export type PanelData = z.infer<typeof PanelData>;

export const StartInvestigationRequest = z.object({
  issueKey: z.string().min(1),
  issueId: z.string().min(1),
  projectKey: z.string().min(1),
  title: z.string().min(1).max(200),
  requestedEnvironments: z.number().int().min(1).max(10).default(3),
  confluencePageId: z.string().regex(/^\d+$/).optional(),
});
export type StartInvestigationRequest = z.infer<typeof StartInvestigationRequest>;

export const StartInvestigationResponse = z.object({
  investigationId: InvestigationId,
  state: InvestigationState,
  mode: IntegrationMode,
});
export type StartInvestigationResponse = z.infer<typeof StartInvestigationResponse>;

export const ReviewContextRequest = z.object({
  investigationId: InvestigationId,
  candidateId: CandidateId,
  evaluationId: EvaluationId,
});
export type ReviewContextRequest = z.infer<typeof ReviewContextRequest>;

export const ReviewContext = z.object({
  investigation: Investigation,
  candidate: ControllerCandidate,
  evaluation: CandidateEvaluation,
  evidencePackUrl: HttpsUrl.optional(),
});
export type ReviewContext = z.infer<typeof ReviewContext>;

export const MoreInvestigationRequest = z.object({
  investigationId: InvestigationId,
  issueKey: z.string().min(1),
  projectKey: z.string().min(1),
  requestedBy: z.string().regex(/^atlassian:.+$/),
  note: z.string().trim().min(1).max(500),
  extraEnvironments: z.number().int().min(1).max(3).optional(),
  idempotencyKey: z.string().uuid(),
}).strict();
export type MoreInvestigationRequest = z.infer<typeof MoreInvestigationRequest>;

export const MoreInvestigationResponse = z.object({
  requestId: z.string().uuid(),
  accepted: z.boolean(),
  state: InvestigationState.optional(),
});
export type MoreInvestigationResponse = z.infer<typeof MoreInvestigationResponse>;

export const RecordReviewRequest = z.object({ review: HumanReview });
export type RecordReviewRequest = z.infer<typeof RecordReviewRequest>;

export const RecordReviewResponse = z.object({
  reviewId: ReviewId,
  recorded: z.boolean(),
});
export type RecordReviewResponse = z.infer<typeof RecordReviewResponse>;
