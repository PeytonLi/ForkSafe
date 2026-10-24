import { describe, expect, it } from "vitest";
import {
  approveBlockedReason,
  dataSourceLabel,
  friendlyError,
  shortSha,
  statusLabel,
  verdict,
  type CandidateItem,
} from "../src/frontend/panel-model.js";

const candidate: CandidateItem = {
  candidate: {
    id: "00000000-0000-4000-8000-000000000121",
    environmentId: "00000000-0000-4000-8000-000000000111",
    status: "evaluated",
    controllerSha256: "a".repeat(64),
    changedFunctions: [],
    submittedAtMs: 1,
  },
  evaluation: {
    id: "00000000-0000-4000-8000-000000000131",
    suite: "public",
    status: "failed",
    allRequiredPassed: false,
    medianCompletionTimeSec: 2,
  },
  passedCases: 6,
  totalCases: 8,
  suites: [
    {
      evaluationId: "00000000-0000-4000-8000-000000000131",
      suite: "public",
      status: "failed",
      allRequiredPassed: false,
      passedCases: 6,
      failedCases: 2,
      totalCases: 8,
      failedCaseIds: ["case-a", "case-b"],
    },
  ],
};

describe("review panel model", () => {
  it("labels data modes and investigation status in plain words", () => {
    expect(dataSourceLabel("live")).toBe("Live data from ForkSafe");
    expect(dataSourceLabel("fixture")).toBe(
      "Sample data, not a real investigation",
    );
    expect(dataSourceLabel("blocked")).toBe("Some services are unavailable");
    expect(statusLabel("awaiting_review")).toBe("Awaiting review");
  });

  it("derives a suite verdict and approval block from evaluation data", () => {
    expect(verdict(candidate)).toMatchObject({
      label: "2 checks failed",
      passed: false,
      suites: [
        {
          suite: "public",
          passedCases: 6,
          failedCases: 2,
          totalCases: 8,
          failedCaseIds: ["case-a", "case-b"],
        },
      ],
    });
    expect(approveBlockedReason(candidate.evaluation)).toContain(
      "The evaluation has not passed yet",
    );
    expect(approveBlockedReason(null)).toContain("completed evaluation");
    expect(
      approveBlockedReason({
        status: "passed",
        allRequiredPassed: true,
      }),
    ).toBeUndefined();
  });

  it("does not call a non-passing evaluation with no failures a pass", () => {
    const queuedCandidate: CandidateItem = {
      ...candidate,
      evaluation: {
        ...candidate.evaluation!,
        status: "queued",
        allRequiredPassed: false,
      },
      suites: [
        {
          ...candidate.suites![0]!,
          status: "queued",
          allRequiredPassed: false,
          passedCases: 0,
          failedCases: 0,
        },
      ],
    };
    expect(verdict(queuedCandidate)).toMatchObject({
      label: "Evaluation did not pass",
      passed: false,
      failedChecks: 0,
    });
  });

  it("shortens hashes and keeps error copy friendly", () => {
    expect(shortSha("a".repeat(64))).toBe("a".repeat(12));
    expect(friendlyError("not_available_yet")).toContain("isn't available yet");
    expect(friendlyError("unknown_backend_code")).not.toContain(
      "unknown_backend_code",
    );
  });
});
