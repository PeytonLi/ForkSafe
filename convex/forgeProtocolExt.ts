// mirror of #18's forge-protocol; replace with imports once it merges
import { ArtifactId, EnvironmentId, EvaluationId, EvaluationStatus, EvidenceKind, ExperimentId, FindingId, FindingKind, InvestigationId, InvestigationState } from "@forksafe/contracts";
import { PanelData as BasePanelData, ReviewContext as BaseReviewContext } from "../packages/integrations/atlassian/src/forge-protocol.js";
import { z } from "zod";

export const FORGE_FEATURE_PATHS = { requests: "/forge/v1/requests" } as const;
const HttpsUrl = z.string().url().refine((value) => value.startsWith("https://"));
export const SuiteSummary = z.object({
  evaluationId: EvaluationId, suite: z.enum(["public", "withheld"]), status: EvaluationStatus,
  allRequiredPassed: z.boolean(), passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(), totalCases: z.number().int().nonnegative(),
  failedCaseIds: z.array(z.string()).max(50).optional(),
});
export const FindingSummary = z.object({
  id: FindingId, kind: FindingKind, summary: z.string().max(500), environmentId: EnvironmentId,
  citations: z.array(z.object({ kind: EvidenceKind, artifactId: ArtifactId.optional(), experimentId: ExperimentId.optional() })).max(10),
});
export const PanelData = BasePanelData.extend({
  findings: z.array(FindingSummary).max(25).optional(),
  candidates: z.array(BasePanelData.shape.candidates.element.extend({ suites: z.array(SuiteSummary).optional() })),
  links: BasePanelData.shape.links.extend({ webAppUrl: HttpsUrl.optional(), evidencePackUrl: HttpsUrl.optional() }),
});
export const ReviewContext = BaseReviewContext.extend({ evidencePackUrl: HttpsUrl.optional() });
export const MoreInvestigationRequest = z.object({
  investigationId: InvestigationId, issueKey: z.string().min(1), projectKey: z.string().min(1),
  requestedBy: z.string().regex(/^atlassian:.+$/), note: z.string().trim().min(1).max(500),
  extraEnvironments: z.number().int().min(1).max(3).optional(), idempotencyKey: z.string().uuid(),
}).strict();
export const MoreInvestigationResponse = z.object({ requestId: z.string().uuid(), accepted: z.boolean(), state: InvestigationState.optional() });
