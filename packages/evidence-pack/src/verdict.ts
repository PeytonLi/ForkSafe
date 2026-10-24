import type { CandidateEvaluation } from "@forksafe/contracts";
import type { EvidenceBundle } from "./bundle.js";
import { recomputeSuite } from "./verify.js";

export type CandidateVerdict =
  | "passed_all" // public + withheld suites passed
  | "public_only" // public passed, withheld not yet evaluated
  | "failed"
  | "invalid"
  | "pending"
  | "not_evaluated";

export interface SuiteOutcome {
  evaluationId: string;
  evaluatorAttemptId: string;
  status: "passed" | "failed" | "invalid" | "pending";
  passed: number;
  total: number;
  medianCompletionTimeSec?: number;
}

export interface CandidateOutcome {
  candidateId: string;
  controllerSha256: string;
  changedFunctions: number;
  public?: SuiteOutcome;
  withheld?: SuiteOutcome;
  verdict: CandidateVerdict;
}

export interface OverallVerdict {
  verdict: "candidate_passed" | "no_passing_candidate" | "evaluation_incomplete" | "no_candidates";
  headline: string;
  recommendedCandidateId?: string;
  outcomes: CandidateOutcome[];
}

function suite(ev: CandidateEvaluation | undefined): SuiteOutcome | undefined {
  if (!ev) return undefined;
  const re = recomputeSuite(ev.cases);
  return {
    evaluationId: ev.id,
    evaluatorAttemptId: ev.evaluatorAttemptId,
    status: re.status,
    passed: ev.cases.filter((c) => c.status === "passed").length,
    total: ev.cases.length,
    ...(re.medianCompletionTimeSec === undefined ? {} : { medianCompletionTimeSec: re.medianCompletionTimeSec }),
  };
}

/** Verdict derived only from evaluator per-case results. Agent rationale,
 *  findings and reviews never influence it. */
export function computeVerdict(b: EvidenceBundle): OverallVerdict {
  const outcomes: CandidateOutcome[] = b.candidates.map(({ candidate: c }) => {
    const pub = suite(b.evaluations.find((e) => e.candidateId === c.id && e.suite === "public"));
    const wh = suite(b.evaluations.find((e) => e.candidateId === c.id && e.suite === "withheld"));
    let verdict: CandidateVerdict;
    if (!pub) verdict = wh ? "invalid" : "not_evaluated";
    else if (pub.status === "pending" || wh?.status === "pending") verdict = "pending";
    else if (pub.status === "invalid" || wh?.status === "invalid") verdict = "invalid";
    else if (pub.status === "failed" || wh?.status === "failed") verdict = "failed";
    else verdict = wh ? "passed_all" : "public_only";
    return {
      candidateId: c.id,
      controllerSha256: c.controllerSha256,
      changedFunctions: c.changedFunctions.length,
      ...(pub ? { public: pub } : {}),
      ...(wh ? { withheld: wh } : {}),
      verdict,
    };
  });

  // PRD A7 review policy: fewer changed functions, lower median successful
  // completion time, then stable candidate id.
  const eligible = outcomes
    .filter((o) => o.verdict === "passed_all")
    .sort(
      (a, b) =>
        a.changedFunctions - b.changedFunctions ||
        (a.withheld?.medianCompletionTimeSec ?? a.public?.medianCompletionTimeSec ?? Infinity) -
          (b.withheld?.medianCompletionTimeSec ?? b.public?.medianCompletionTimeSec ?? Infinity) ||
        (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0),
    );
  const n = outcomes.length;
  if (!n) return { verdict: "no_candidates", headline: "No candidate was submitted.", outcomes };
  const best = eligible[0];
  if (best) {
    return {
      verdict: "candidate_passed",
      headline: `${eligible.length} of ${n} candidate${n === 1 ? "" : "s"} passed every public and withheld case.`,
      recommendedCandidateId: best.candidateId,
      outcomes,
    };
  }
  const incomplete = outcomes.some((o) => o.verdict === "pending" || o.verdict === "public_only" || o.verdict === "not_evaluated");
  if (incomplete) {
    return {
      verdict: "evaluation_incomplete",
      headline: `No candidate has finished both suites yet (${n} submitted).`,
      outcomes,
    };
  }
  return { verdict: "no_passing_candidate", headline: `None of the ${n} candidate${n === 1 ? "" : "s"} passed every required case.`, outcomes };
}
