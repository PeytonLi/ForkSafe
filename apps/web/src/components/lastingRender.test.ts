import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClientProvider } from "../hooks";
import { FixtureClient } from "../services";
import { FailureMinimizer } from "./FailureMinimizer";
import { ChallengeCaseForm } from "./ChallengeCaseForm";
import { SearchWidthPanel } from "./SearchWidthPanel";
import type { InvestigationWorkspace } from "../services";

const workspace = {
  investigation: {
    id: "inv-1",
    state: "searching",
    title: "Divider",
    baselineCase: { caseId: "original-divider-collision", suite: "original", seed: 4, sceneOverrides: { dividerDx: -0.08 }, taskFamily: "divider_pick_place" },
    baselineExperimentId: "exp-1",
    requestedEnvironments: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  },
  environments: [],
  sessions: [],
  experiments: [],
  candidates: [],
  evaluations: [],
  reviews: [],
  cancellation: "none",
  asOfMs: 1,
} as InvestigationWorkspace;

describe("lasting follow-on render", () => {
  it("renders the recorded shrink label and does not invent a pass", () => {
    const html = renderToStaticMarkup(createElement(FailureMinimizer, {
      taskFamily: "divider_pick_place",
      overrides: { dividerDx: -0.08 },
      seed: 4,
      onApply: () => {},
    }));
    expect(html).toContain("This shrink uses a fixed recorded scene model, not a new MuJoCo run.");
    expect(html).toContain("Shrink this failure");
    expect(html).toContain('data-seed="4"');
    expect(html).not.toContain("passed");
  });

  it("renders a challenge as waiting for physics", () => {
    const html = renderToStaticMarkup(createElement(ClientProvider, {
      client: new FixtureClient(),
      children: createElement(ChallengeCaseForm, { workspace, candidateId: "cand-1" }),
    }));
    expect(html).toContain('data-testid="challenge-case"');
    expect(html).toContain("Ask for this case");
    expect(html).not.toContain("useMutation");
    expect(html).not.toContain("All required passed");
  });

  it("renders search width from the loading panel before any count exists", () => {
    const html = renderToStaticMarkup(createElement(ClientProvider, {
      client: new FixtureClient(),
      children: createElement(SearchWidthPanel),
    }));
    expect(html).toContain('data-testid="search-width"');
    expect(html).toContain("Search width");
  });
});
