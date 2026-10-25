import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../hooks";
import { FixtureClient, type InvestigationWorkspace } from "../services";
import { CaseFile } from "./CaseFile";
import { CASE_FILE_LIMITS, buildCaseFile } from "./caseFile";
import { challengesFor } from "./challengeCase";

vi.mock("./challengeCase", () => ({
  challengesFor: () => [{
    id: "ch-1",
    candidateId: "cand-9",
    caseId: "extra-gap",
    note: "Requested after the review.",
    status: "pending_physics",
    sceneOverrides: { gap_mm: 4 },
  }],
}));

const REVIEW_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function workspace(overrides: {
  taskFamily?: string | null;
  experiments?: { id: string; failureKinds: string[]; completed: boolean; completionTimeSec?: number; startedAtMs: number }[];
  candidates?: { id: string; environmentId: string; controllerSha256: string; status: string }[];
  evaluations?: { candidateId: string; suite: string; allRequiredPassed: boolean; cases: { caseId: string; status: string; failureKinds: string[] }[] }[];
  reviews?: { decision: string; controllerSha256: string; createdAtMs: number }[];
} = {}): InvestigationWorkspace {
  const taskFamily = overrides.taskFamily === null ? undefined : overrides.taskFamily ?? "push_cube";
  return {
    investigation: {
      id: "inv-1",
      title: "Recorded investigation",
      state: "awaiting_review",
      baselineCase: {
        caseId: "baseline-1",
        suite: "original",
        seed: 7,
        sceneOverrides: { divider_x: 0.12 },
        ...(taskFamily ? { taskFamily } : {}),
      },
      baselineExperimentId: "exp-base",
      requestedEnvironments: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    environments: [{ id: "env-1", index: 2 }],
    sessions: [],
    experiments: overrides.experiments ?? [],
    candidates: overrides.candidates ?? [],
    evaluations: overrides.evaluations ?? [],
    reviews: overrides.reviews ?? [],
    cancellation: "none",
    asOfMs: 3,
  } as unknown as InvestigationWorkspace;
}

describe("buildCaseFile", () => {
  it("keeps a failed case visible and copies the review hash exactly", () => {
    const file = buildCaseFile(workspace({
      candidates: [{
        id: "cand-1",
        environmentId: "env-1",
        controllerSha256: REVIEW_HASH,
        status: "evaluated",
      }],
      evaluations: [{
        candidateId: "cand-1",
        suite: "withheld",
        allRequiredPassed: false,
        cases: [
          { caseId: "hidden-pass", status: "passed", failureKinds: [] },
          { caseId: "hidden-fail", status: "failed", failureKinds: ["forbidden_contact"] },
        ],
      }],
      reviews: [{
        decision: "needs_changes",
        controllerSha256: REVIEW_HASH,
        createdAtMs: 1_700_000_000_000,
      }],
    }));

    const suite = file.candidates[0]?.suites[0];
    expect(suite?.cases.map((item) => item.caseId)).toEqual(["hidden-pass", "hidden-fail"]);
    expect(suite?.cases.find((item) => item.caseId === "hidden-fail")).toEqual({
      caseId: "hidden-fail",
      status: "failed",
      failureKinds: ["forbidden_contact"],
    });
    expect(suite?.allRequiredPassed).toBe(false);
    expect(suite?.failureKinds).toEqual(["forbidden_contact"]);
    expect(file.candidates[0]?.environmentIndex).toBe(2);
    expect(file.reviews).toEqual([{
      decision: "needs_changes",
      controllerSha256: REVIEW_HASH,
      createdAtMs: 1_700_000_000_000,
    }]);
    expect(file.reviews[0]?.controllerSha256).toHaveLength(64);
    expect(file.limits).toEqual([...CASE_FILE_LIMITS]);
    expect(file.challenges).toEqual(challengesFor("inv-1").map((challenge) => ({
      id: challenge.id,
      candidateId: challenge.candidateId,
      caseId: challenge.caseId,
      note: challenge.note,
      status: challenge.status,
      sceneOverrides: { ...challenge.sceneOverrides },
      ...(typeof challenge.seed === "number" ? { seed: challenge.seed } : {}),
      ...(typeof challenge.createdAtMs === "number" ? { createdAtMs: challenge.createdAtMs } : {}),
    })));
    expect(file.challenges.every((challenge) => challenge.status === "pending_physics")).toBe(true);
  });

  it("does not invent a failure time when no failure experiment was recorded", () => {
    const empty = buildCaseFile(workspace({ taskFamily: null, experiments: [] }));
    expect(empty.taskFamily).toBe("unspecified");
    expect(empty.baseline).toEqual({
      caseId: "baseline-1",
      seed: 7,
      sceneOverrides: [["divider_x", 0.12]],
    });
    expect(empty.failure).toEqual({ recorded: false, summary: "There is no recorded failure experiment." });
    expect(empty.failure).not.toHaveProperty("completionTimeSec");

    const succeeded = buildCaseFile(workspace({
      experiments: [{
        id: "exp-ok",
        failureKinds: [],
        completed: true,
        completionTimeSec: 6.4,
        startedAtMs: 4,
      }],
    }));
    expect(succeeded.failure).toEqual({ recorded: false, summary: "There is no recorded failure experiment." });
    expect(JSON.stringify(succeeded.failure)).not.toContain("6.4");
  });

  it("reports the earliest failure without borrowing a later completion time", () => {
    const file = buildCaseFile(workspace({
      experiments: [
        {
          id: "later",
          failureKinds: ["stalled"],
          completed: true,
          completionTimeSec: 8,
          startedAtMs: 30,
        },
        {
          id: "earlier",
          failureKinds: ["timeout", "stalled"],
          completed: false,
          startedAtMs: 5,
        },
      ],
    }));
    expect(file.failure).toEqual({
      recorded: true,
      experimentId: "earlier",
      kinds: ["timeout", "stalled"],
      completed: false,
    });

    const timed = buildCaseFile(workspace({
      experiments: [{
        id: "exp-fail",
        failureKinds: ["joint_limit"],
        completed: false,
        completionTimeSec: 2.5,
        startedAtMs: 1,
      }],
    }));
    expect(timed.failure).toMatchObject({
      experimentId: "exp-fail",
      kinds: ["joint_limit"],
      completed: false,
      completionTimeSec: 2.5,
    });
  });

  it("renders the full controller hash, the failed case, and a challenge still waiting for physics", () => {
    const html = renderToStaticMarkup(createElement(ClientProvider, {
      client: new FixtureClient({ latencyMs: 0, storage: null }),
      children: createElement(CaseFile, {
        workspace: workspace({
          experiments: [],
          candidates: [{
            id: "cand-1",
            environmentId: "env-1",
            controllerSha256: REVIEW_HASH,
            status: "evaluated",
          }],
          evaluations: [{
            candidateId: "cand-1",
            suite: "public",
            allRequiredPassed: false,
            cases: [{ caseId: "hidden-fail", status: "failed", failureKinds: ["timeout"] }],
          }],
          reviews: [{ decision: "approved", controllerSha256: REVIEW_HASH, createdAtMs: 1_700_000_000_000 }],
        }),
      }),
    }));
    expect(html).toContain('data-testid="case-file"');
    expect(html).toContain(`<code class="`);
    expect(html).toContain(REVIEW_HASH);
    expect(html).not.toContain(REVIEW_HASH.slice(0, 12) + "</code>");
    expect(html).toContain("hidden-fail");
    expect(html).toContain("There is no recorded failure experiment.");
    const challenges = html.slice(html.indexOf("Pending challenges"), html.indexOf("What this result does not prove"));
    expect(challenges).toContain("Waiting for physics");
    expect(challenges).toContain("extra-gap");
    expect(challenges).not.toMatch(/Passed|Failed/);
  });
});
