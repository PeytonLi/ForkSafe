import {
  HumanReview,
  CandidateId,
  EvaluationId,
  InvestigationId,
  type ReviewId,
  type ReviewDecision,
} from "@forksafe/contracts";
import { z } from "zod";
import type { ReviewContext } from "./forge-protocol.js";

export const ReviewRequest = z
  .object({
    investigationId: InvestigationId,
    candidateId: CandidateId,
    evaluationId: EvaluationId,
    controllerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    decision: z.enum(["approved", "rejected", "needs_changes"]),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type ReviewRequest = z.infer<typeof ReviewRequest>;

export type ValidateReviewResult =
  | { ok: true; review: HumanReview }
  | { ok: false; code: string; message: string };

export function validateReview(
  req: ReviewRequest,
  ctx: ReviewContext,
  {
    reviewerIdentity,
    reviewId,
    nowMs,
    jiraIssueKey,
  }: {
    reviewerIdentity: string;
    reviewId: ReviewId;
    nowMs: number;
    jiraIssueKey?: string;
  },
): ValidateReviewResult {
  const mismatch = (
    code: string,
    message: string,
  ): ValidateReviewResult => ({ ok: false, code, message });
  if (
    ctx.investigation.id !== req.investigationId ||
    ctx.candidate.investigationId !== req.investigationId
  ) {
    return mismatch("investigation_mismatch", "Review does not match this investigation.");
  }
  if (ctx.candidate.id !== req.candidateId) {
    return mismatch("candidate_mismatch", "Review does not match this candidate.");
  }
  if (req.controllerSha256 !== ctx.candidate.controllerSha256) {
    return mismatch("sha_mismatch", "The candidate version changed since it was loaded.");
  }
  if (
    ctx.evaluation.id !== req.evaluationId ||
    ctx.evaluation.candidateId !== ctx.candidate.id
  ) {
    return mismatch("evaluation_mismatch", "Review does not match this evaluation.");
  }
  if (ctx.investigation.state !== "awaiting_review") {
    return mismatch("not_awaiting_review", "The investigation is not awaiting review.");
  }
  if (ctx.candidate.status !== "evaluated") {
    return mismatch("candidate_not_evaluated", "The candidate has not been evaluated.");
  }
  if (
    req.decision === "approved" &&
    (ctx.evaluation.status !== "passed" || !ctx.evaluation.allRequiredPassed)
  ) {
    return mismatch("evaluation_not_passed", "Only a passing evaluation can be approved.");
  }
  if (!reviewerIdentity) {
    return mismatch("unauthenticated", "A signed-in Atlassian reviewer is required.");
  }
  const review = HumanReview.parse({
    id: reviewId,
    investigationId: req.investigationId,
    candidateId: req.candidateId,
    evaluationId: req.evaluationId,
    controllerSha256: req.controllerSha256,
    decision: req.decision satisfies ReviewDecision,
    reviewerIdentity,
    ...(req.notes === undefined ? {} : { notes: req.notes }),
    ...(jiraIssueKey === undefined ? {} : { jiraIssueKey }),
    createdAtMs: nowMs,
  });
  return { ok: true, review };
}
