import {
  FORGE_BACKEND_PATHS,
  FORGE_FEATURE_PATHS,
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
  it("keeps backend routes stable and exposes requests as a feature path", () => {
    expect(FORGE_BACKEND_PATHS).toEqual({
      panel: "/forge/v1/panel",
      start: "/forge/v1/investigations",
      reviewContext: "/forge/v1/review-context",
      review: "/forge/v1/reviews",
    });
    expect(FORGE_FEATURE_PATHS).toEqual({
      requests: "/forge/v1/requests",
    });
  });

  it("continues to parse the existing Convex panel shape", () => {
    expect(PanelData.parse(oldConvexPanel)).toEqual(oldConvexPanel);
  });

  it("allows legacy HTTP investigation and report URLs", () => {
    const panel = PanelData.parse({
      ...oldConvexPanel,
      links: {
        investigationUrl: "http://localhost:3000/investigations/123",
        reportUrl: "http://localhost:3000/reports/123",
      },
    });
    expect(panel.links.investigationUrl).toBe(
      "http://localhost:3000/investigations/123",
    );
    expect(panel.links.reportUrl).toBe("http://localhost:3000/reports/123");
  });

  it("rejects non-HTTPS evidence URLs", () => {
    expect(() =>
      PanelData.parse({
        ...oldConvexPanel,
        links: { evidencePackUrl: "http://example.invalid/evidence" },
      }),
    ).toThrow();
    expect(() =>
      PanelData.parse({
        ...oldConvexPanel,
        links: { webAppUrl: "http://example.invalid/app" },
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
