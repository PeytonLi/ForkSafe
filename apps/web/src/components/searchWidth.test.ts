import { describe, expect, it } from "vitest";
import { countPassedCandidates, searchWidthReport, type SearchWidthRow } from "./searchWidth";

function row(overrides: Partial<SearchWidthRow> & Pick<SearchWidthRow, "id" | "taskFamily" | "requestedEnvironments">): SearchWidthRow {
  return {
    title: overrides.id,
    findingCount: 0,
    candidateCount: 0,
    passedCandidateCount: 0,
    ...overrides,
  };
}

describe("search width", () => {
  it("groups by task family and environment count and sums only returned rows", () => {
    expect(searchWidthReport([
      row({ id: "b", title: "Push wide", taskFamily: "push_through_gap", requestedEnvironments: 2, findingCount: 1, candidateCount: 1, passedCandidateCount: 0 }),
      row({ id: "a", title: "Divider A", taskFamily: "divider_pick_place", requestedEnvironments: 4, findingCount: 2, candidateCount: 3, passedCandidateCount: 1 }),
      row({ id: "c", title: "Divider narrow", taskFamily: "divider_pick_place", requestedEnvironments: 1, findingCount: 4, candidateCount: 1, passedCandidateCount: 1 }),
      row({ id: "d", title: "Divider B", taskFamily: "divider_pick_place", requestedEnvironments: 4, findingCount: 1, candidateCount: 2, passedCandidateCount: 0 }),
    ])).toEqual([
      { taskFamily: "divider_pick_place", requestedEnvironments: 1, investigationCount: 1, findingCount: 4, candidateCount: 1, passedCandidateCount: 1 },
      { taskFamily: "divider_pick_place", requestedEnvironments: 4, investigationCount: 2, findingCount: 3, candidateCount: 5, passedCandidateCount: 1 },
      { taskFamily: "push_through_gap", requestedEnvironments: 2, investigationCount: 1, findingCount: 1, candidateCount: 1, passedCandidateCount: 0 },
    ]);
  });

  it("returns no groups when the caller has no investigations", () => {
    expect(searchWidthReport([])).toEqual([]);
  });

  it("counts a candidate only when every recorded evaluation passed", () => {
    expect(countPassedCandidates(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { candidateId: "a", allRequiredPassed: true },
        { candidateId: "a", allRequiredPassed: false },
        { candidateId: "b", allRequiredPassed: true },
      ],
    )).toBe(1);
    expect(countPassedCandidates([{ id: "d" }], [])).toBe(0);
  });
});
