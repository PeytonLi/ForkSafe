import { describe, expect, it } from "vitest";
import { environmentExchange } from "./environmentExchange";

const workspace = {
  environments: [
    { id: "env-a", index: 0 },
    { id: "env-b", index: 1 },
    { id: "env-c", index: 2 },
  ],
  candidates: [
    { id: "cand-c", environmentId: "env-c", basedOnFindings: ["f2", "f1", "f1"] },
    { id: "cand-self", environmentId: "env-a", basedOnFindings: ["f1"] },
    { id: "cand-b2", environmentId: "env-b", basedOnFindings: ["f1", "missing"] },
    { id: "cand-b1", environmentId: "env-b", basedOnFindings: ["f2"] },
    { id: "cand-gone", environmentId: "env-missing", basedOnFindings: ["f1"] },
  ],
};

const findings = [
  { id: "f2", environmentId: "env-a", summary: "divider contact at the grasp" },
  { id: "f-other", environmentId: "env-b", summary: "belongs to env b" },
  { id: "f1", environmentId: "env-a", summary: "wrist stalled above the cube" },
];

describe("environmentExchange", () => {
  it("keeps authored order and stably sorts citations from other environments", () => {
    expect(environmentExchange("env-a", workspace, findings)).toEqual({
      authored: [
        { id: "f2", summary: "divider contact at the grasp" },
        { id: "f1", summary: "wrist stalled above the cube" },
      ],
      citedBy: [
        { environmentIndex: 1, candidateId: "cand-b2", findingId: "f1" },
        { environmentIndex: 1, candidateId: "cand-b1", findingId: "f2" },
        { environmentIndex: 2, candidateId: "cand-c", findingId: "f2" },
        { environmentIndex: 2, candidateId: "cand-c", findingId: "f1" },
      ],
    });
  });

  it("returns nothing authored when this environment published no findings", () => {
    expect(environmentExchange("env-c", workspace, findings)).toEqual({ authored: [], citedBy: [] });
  });
});
