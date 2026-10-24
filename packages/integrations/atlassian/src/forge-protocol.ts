import {
  CandidateEvaluation,
  CandidateId,
  ControllerCandidate,
  EvaluationId,
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

export const PanelRequest = z.object({
  issueKey: z.string().min(1),
  issueId: z.string().min(1),
  projectKey: z.string().min(1),
});
export type PanelRequest = z.infer<typeof PanelRequest>;

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

export const PanelData = z.object({
  mode: IntegrationMode,
  issue: z.object({ key: z.string(), id: z.string() }),
  readiness: IntegrationReadiness.array(),
  investigation: PanelInvestigation.nullable(),
  environments: PanelEnvironment.array(),
  findingsCount: z.number().int().nonnegative(),
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
});
export type ReviewContext = z.infer<typeof ReviewContext>;

export const RecordReviewRequest = z.object({ review: HumanReview });
export type RecordReviewRequest = z.infer<typeof RecordReviewRequest>;

export const RecordReviewResponse = z.object({
  reviewId: ReviewId,
  recorded: z.boolean(),
});
export type RecordReviewResponse = z.infer<typeof RecordReviewResponse>;
