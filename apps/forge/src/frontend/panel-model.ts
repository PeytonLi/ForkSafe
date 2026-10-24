import type { PanelData } from "@forksafe/integrations-atlassian";

type CandidatePanelItem = PanelData["candidates"][number];
type Evaluation = NonNullable<CandidatePanelItem["evaluation"]>;

export function dataSourceLabel(mode: string): string {
  switch (mode) {
    case "live":
      return "Live data from ForkSafe";
    case "fixture":
      return "Sample data, not a real investigation";
    case "local":
      return "Local ForkSafe data";
    default:
      return "Some services are unavailable";
  }
}

export function statusLabel(state?: string | null): string {
  if (!state) return "No investigation";
  const labels: Record<string, string> = {
    capturing: "Capturing baseline",
    admitted: "Ready to investigate",
    searching: "Investigating",
    evaluating: "Evaluating candidates",
    awaiting_review: "Awaiting review",
    completed: "Completed",
    cancelled: "Cancelled",
    failed: "Needs attention",
  };
  return labels[state] ?? "In progress";
}

export function verdict(candidate: CandidatePanelItem) {
  const suites = candidate.suites?.map((suite) => ({
    suite: suite.suite,
    passedCases: suite.passedCases,
    failedCases: suite.failedCases,
    totalCases: suite.totalCases,
    status: suite.status,
    allRequiredPassed: suite.allRequiredPassed,
    ...(suite.suite === "public" && suite.failedCaseIds
      ? { failedCaseIds: suite.failedCaseIds }
      : {}),
  })) ?? (candidate.evaluation
    ? [
        {
          suite: candidate.evaluation.suite,
          passedCases: candidate.passedCases,
          failedCases: Math.max(0, candidate.totalCases - candidate.passedCases),
          totalCases: candidate.totalCases,
          status: candidate.evaluation.status,
          allRequiredPassed: candidate.evaluation.allRequiredPassed,
        },
      ]
    : []);
  const failedChecks = suites.reduce((total, suite) => total + suite.failedCases, 0);
  const passed = suites.length > 0 && suites.every(
    (suite) => suite.status === "passed" && suite.allRequiredPassed,
  );
  return {
    label: passed
      ? "All required checks passed"
      : failedChecks > 0
        ? `${failedChecks} ${failedChecks === 1 ? "check" : "checks"} failed`
        : "Evaluation did not pass",
    passed,
    failedChecks,
    suites,
  };
}

export function approveBlockedReason(
  evaluation?: Pick<Evaluation, "status" | "allRequiredPassed"> | null,
): string | undefined {
  if (!evaluation) return "A completed evaluation is needed before approval.";
  if (evaluation.status !== "passed") {
    return "The evaluation has not passed yet.";
  }
  if (!evaluation.allRequiredPassed) {
    return "Some required checks failed, so this candidate cannot be approved.";
  }
  return undefined;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function friendlyError(code: string): string {
  const messages: Record<string, string> = {
    unauthenticated: "Sign in to Jira before continuing.",
    unauthorized: "Your Jira sign-in has expired. Sign in again and retry.",
    forbidden: "You don't have access to this ForkSafe investigation.",
    not_found: "This ForkSafe investigation could not be found.",
    version_changed:
      "This candidate changed since you opened it. Reload the panel to review the latest version.",
    review_conflict:
      "This review conflicts with one already recorded. Reload the panel before trying again.",
    not_awaiting_review: "This investigation is no longer waiting for review.",
    candidate_not_evaluated: "This candidate has not finished evaluation yet.",
    evaluation_not_passed:
      "Only a candidate that passed all required checks can be approved.",
    not_available_yet:
      "Asking for more investigation from Jira isn't available yet.",
    no_issue_context:
      "Open this panel from a Jira issue to see its ForkSafe investigation.",
    backend_error: "ForkSafe couldn't complete that request. Try again shortly.",
    invalid_request: "Check the form and try again.",
  };
  return messages[code] ?? "Something went wrong. Try again shortly.";
}

export type CandidateItem = CandidatePanelItem;
export type CandidateEvaluation = Evaluation;
