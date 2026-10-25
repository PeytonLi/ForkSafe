import type { InvestigationWorkspace } from "../services";
import { challengesFor } from "./challengeCase";

/** Sentences that stay true no matter what this investigation recorded. */
export const CASE_FILE_LIMITS = [
  "Approval stays on the controller hash and does not merge code.",
  "Nothing here deploys a physical robot.",
  "Withheld cases stay hidden; only their pass or fail is shown.",
  "A challenge case stays unscored until a physics run records it.",
] as const;

export interface CaseFileCase {
  caseId: string;
  status: string;
  failureKinds: string[];
}

export interface CaseFileSuite {
  suite: string;
  allRequiredPassed: boolean;
  failureKinds: string[];
  cases: CaseFileCase[];
}

export interface CaseFileCandidate {
  id: string;
  environmentIndex: number | null;
  controllerSha256: string;
  status: string;
  suites: CaseFileSuite[];
}

export interface CaseFileReview {
  decision: string;
  controllerSha256: string;
  createdAtMs: number;
}

export interface PendingChallenge {
  id: string;
  candidateId: string;
  caseId: string;
  note: string;
  status: "pending_physics";
  sceneOverrides: Record<string, number>;
  seed?: number;
  createdAtMs?: number;
}

export type CaseFileFailure =
  | {
      recorded: false;
      summary: string;
    }
  | {
      recorded: true;
      experimentId: string;
      kinds: string[];
      completed: boolean;
      completionTimeSec?: number;
    };

export interface CaseFileModel {
  title: string;
  investigationId: string;
  state: string;
  taskFamily: string;
  baseline: {
    caseId: string;
    seed: number;
    sceneOverrides: [string, number][];
  };
  failure: CaseFileFailure;
  candidates: CaseFileCandidate[];
  reviews: CaseFileReview[];
  challenges: PendingChallenge[];
  limits: readonly string[];
}

const NO_FAILURE = "There is no recorded failure experiment.";

function gatheredKinds(cases: { failureKinds: readonly string[] }[]): string[] {
  const kinds: string[] = [];
  for (const item of cases) {
    for (const kind of item.failureKinds) {
      if (!kinds.includes(kind)) kinds.push(kind);
    }
  }
  return kinds;
}

/** One read-only page from the workspace. Missing runs stay missing. */
export function buildCaseFile(workspace: InvestigationWorkspace): CaseFileModel {
  const investigation = workspace.investigation;
  const baseline = investigation.baselineCase;
  const earliestFailure = [...workspace.experiments]
    .filter((experiment) => experiment.failureKinds.length > 0)
    .sort((a, b) => a.startedAtMs - b.startedAtMs)[0];

  const failure: CaseFileFailure = earliestFailure
    ? {
        recorded: true,
        experimentId: earliestFailure.id,
        kinds: [...earliestFailure.failureKinds],
        completed: earliestFailure.completed,
        ...(typeof earliestFailure.completionTimeSec === "number"
          ? { completionTimeSec: earliestFailure.completionTimeSec }
          : {}),
      }
    : { recorded: false, summary: NO_FAILURE };

  const environmentIndex = new Map(workspace.environments.map((environment) => [environment.id, environment.index]));

  return {
    title: investigation.title,
    investigationId: investigation.id,
    state: investigation.state,
    taskFamily: baseline.taskFamily || "unspecified",
    baseline: {
      caseId: baseline.caseId,
      seed: baseline.seed,
      sceneOverrides: Object.entries(baseline.sceneOverrides),
    },
    failure,
    candidates: workspace.candidates.map((candidate) => ({
      id: candidate.id,
      environmentIndex: environmentIndex.get(candidate.environmentId) ?? null,
      controllerSha256: candidate.controllerSha256,
      status: candidate.status,
      suites: workspace.evaluations
        .filter((evaluation) => evaluation.candidateId === candidate.id)
        .map((evaluation) => ({
          suite: evaluation.suite,
          allRequiredPassed: evaluation.allRequiredPassed,
          failureKinds: gatheredKinds(evaluation.cases),
          cases: evaluation.cases.map((item) => ({
            caseId: item.caseId,
            status: item.status,
            failureKinds: [...item.failureKinds],
          })),
        })),
    })),
    reviews: workspace.reviews.map((review) => ({
      decision: review.decision,
      controllerSha256: review.controllerSha256,
      createdAtMs: review.createdAtMs,
    })),
    challenges: challengesFor(workspace.investigation.id).map((challenge) => ({
      id: challenge.id,
      candidateId: challenge.candidateId,
      caseId: challenge.caseId,
      note: challenge.note,
      status: challenge.status,
      sceneOverrides: { ...challenge.sceneOverrides },
      ...(typeof challenge.seed === "number" ? { seed: challenge.seed } : {}),
      ...(typeof challenge.createdAtMs === "number" ? { createdAtMs: challenge.createdAtMs } : {}),
    })),
    limits: [...CASE_FILE_LIMITS],
  };
}
