import {
  CandidateEvaluation,
  ControllerCandidate,
  HumanReview,
  Investigation,
} from "@forksafe/contracts";
import { describe, expect, it } from "vitest";
import { ReviewRequest, validateReview } from "../src/review.js";

const ids = {
  investigation: "00000000-0000-4000-8000-000000000001",
  candidate: "00000000-0000-4000-8000-000000000002",
  evaluation: "00000000-0000-4000-8000-000000000003",
  review: "00000000-0000-4000-8000-000000000004",
};
const sha = "a".repeat(64);

function context({
  state = "awaiting_review",
  candidateStatus = "evaluated",
  evaluationStatus = "passed",
  allRequiredPassed = true,
}: {
  state?: "awaiting_review" | "searching";
  candidateStatus?: "evaluated" | "submitted";
  evaluationStatus?: "passed" | "failed";
  allRequiredPassed?: boolean;
} = {}) {
  return {
    investigation: Investigation.parse({
      id: ids.investigation,
      state,
      title: "Test investigation",
      baselineCase: { caseId: "baseline", suite: "original", seed: 1 },
      baselineExperimentId: "00000000-0000-4000-8000-000000000010",
      requestedEnvironments: 3,
      createdAtMs: 1,
      updatedAtMs: 2,
    }),
    candidate: ControllerCandidate.parse({
      id: ids.candidate,
      investigationId: ids.investigation,
      environmentId: "00000000-0000-4000-8000-000000000011",
      status: candidateStatus,
      controllerSha256: sha,
      sourceArtifactId: "00000000-0000-4000-8000-000000000012",
      changedFunctions: [],
      submittedByAttemptId: "00000000-0000-4000-8000-000000000013",
      submittedAtMs: 1,
    }),
    evaluation: CandidateEvaluation.parse({
      id: ids.evaluation,
      candidateId: ids.candidate,
      investigationId: ids.investigation,
      evaluatorAttemptId: "00000000-0000-4000-8000-000000000014",
      suite: "public",
      cases: [],
      allRequiredPassed,
      status: evaluationStatus,
      createdAtMs: 2,
    }),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    investigationId: ids.investigation,
    candidateId: ids.candidate,
    evaluationId: ids.evaluation,
    controllerSha256: sha,
    decision: "approved",
    ...overrides,
  };
}

describe("exact-version human review", () => {
  it("records a valid review and validates it against the shared contract", () => {
    const parsed = ReviewRequest.parse(request({ notes: "Looks good." }));
    const result = validateReview(parsed, context(), {
      reviewerIdentity: "atlassian:account-42",
      reviewId: ids.review,
      nowMs: 100,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.review.reviewerIdentity).toBe("atlassian:account-42");
      expect(HumanReview.parse(result.review)).toEqual(result.review);
    }
  });

  it("rejects every identity/version/state mismatch in validation order", () => {
    const parsed = ReviewRequest.parse(request());
    const mismatches = [
      [
        context(),
        { ...parsed, investigationId: "00000000-0000-4000-8000-000000000099" },
        "investigation_mismatch",
      ],
      [
        context(),
        { ...parsed, candidateId: "00000000-0000-4000-8000-000000000099" },
        "candidate_mismatch",
      ],
      [
        context(),
        { ...parsed, controllerSha256: "b".repeat(64) },
        "sha_mismatch",
      ],
      [
        context(),
        { ...parsed, evaluationId: "00000000-0000-4000-8000-000000000099" },
        "evaluation_mismatch",
      ],
      [context({ state: "searching" }), parsed, "not_awaiting_review"],
      [context({ candidateStatus: "submitted" }), parsed, "candidate_not_evaluated"],
      [context({ evaluationStatus: "failed" }), parsed, "evaluation_not_passed"],
    ] as const;
    for (const [reviewContext, reviewRequest, code] of mismatches) {
      const result = validateReview(reviewRequest, reviewContext, {
        reviewerIdentity: "atlassian:account-42",
        reviewId: ids.review,
        nowMs: 100,
      });
      expect(result).toMatchObject({ ok: false, code });
    }
  });

  it("allows rejection after a failed evaluation and rejects uppercase hashes at schema time", () => {
    const failedContext = context({ evaluationStatus: "failed", allRequiredPassed: false });
    const reject = ReviewRequest.parse(request({ decision: "rejected" }));
    expect(
      validateReview(reject, failedContext, {
        reviewerIdentity: "atlassian:account-42",
        reviewId: ids.review,
        nowMs: 100,
      }).ok,
    ).toBe(true);
    expect(
      ReviewRequest.safeParse(request({ controllerSha256: sha.toUpperCase() })).success,
    ).toBe(false);
  });

  it("rejects client-supplied reviewer identity and empty authenticated identity", () => {
    expect(
      ReviewRequest.safeParse(
        request({ reviewerIdentity: "atlassian:forged-account" }),
      ).success,
    ).toBe(false);
    const parsed = ReviewRequest.parse(request());
    expect(
      validateReview(parsed, context(), {
        reviewerIdentity: "",
        reviewId: ids.review,
        nowMs: 100,
      }),
    ).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});
