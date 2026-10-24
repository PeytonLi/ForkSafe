import {
  FORGE_BACKEND_PATHS,
  MoreInvestigationRequest,
  PanelData,
} from "../src/forge-protocol.js";
import { describe, expect, it } from "vitest";

const oldConvexPanel = {
  mode: "live",
  issue: { key: "FS-42", id: "10042" },
  readiness: [],
  investigation: null,
  environments: [],
  findingsCount: 0,
  candidates: [],
  underReview: null,
  reviews: [],
  requirements: null,
  links: {},
  fetchedAtMs: 1761200000000,
};

describe("Forge protocol", () => {
  it("adds the request route without changing the existing route list", () => {
    expect(FORGE_BACKEND_PATHS.requests).toBe("/forge/v1/requests");
    expect(Object.values(FORGE_BACKEND_PATHS)).toEqual([
      "/forge/v1/panel",
      "/forge/v1/investigations",
      "/forge/v1/review-context",
      "/forge/v1/reviews",
    ]);
  });

  it("continues to parse the existing Convex panel shape", () => {
    expect(PanelData.parse(oldConvexPanel)).toEqual(oldConvexPanel);
  });

  it("rejects non-HTTPS evidence URLs", () => {
    expect(() =>
      PanelData.parse({
        ...oldConvexPanel,
        links: { evidencePackUrl: "http://example.invalid/evidence" },
      }),
    ).toThrow();
  });

  it("bounds investigation request notes and extra environments", () => {
    const base = {
      investigationId: "00000000-0000-4000-8000-000000000101",
      issueKey: "FS-42",
      projectKey: "FS",
      requestedBy: "atlassian:account-123",
      note: "Please investigate the remaining contact issue.",
      idempotencyKey: "00000000-0000-4000-8000-000000000201",
    };
    expect(MoreInvestigationRequest.safeParse(base).success).toBe(true);
    expect(MoreInvestigationRequest.safeParse({ ...base, note: "   " }).success).toBe(
      false,
    );
    expect(
      MoreInvestigationRequest.safeParse({ ...base, note: "a".repeat(501) })
        .success,
    ).toBe(false);
    expect(
      MoreInvestigationRequest.safeParse({ ...base, extraEnvironments: 0 })
        .success,
    ).toBe(false);
    expect(
      MoreInvestigationRequest.safeParse({ ...base, extraEnvironments: 4 })
        .success,
    ).toBe(false);
    for (const extraEnvironments of [1, 2, 3]) {
      expect(
        MoreInvestigationRequest.safeParse({ ...base, extraEnvironments })
          .success,
      ).toBe(true);
    }
  });
});
