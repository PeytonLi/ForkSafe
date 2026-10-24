import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureBackend } from "../src/backend.js";
import {
  PanelView,
  type PanelViewProps,
} from "../src/frontend/PanelView.js";
import type { PanelData } from "@forksafe/integrations-atlassian";

vi.mock("@forge/react", async () => {
  const react = await import("react");
  const names = [
    "Badge",
    "Button",
    "CodeBlock",
    "Heading",
    "Label",
    "Link",
    "Lozenge",
    "Modal",
    "ModalBody",
    "ModalFooter",
    "ModalHeader",
    "ModalTitle",
    "ModalTransition",
    "RadioGroup",
    "SectionMessage",
    "Spinner",
    "Stack",
    "Text",
    "TextArea",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      (props: Record<string, unknown>) => {
        const { children, ...rest } = props;
        const serializable = Object.fromEntries(
          Object.entries(rest).filter(([, value]) =>
            ["string", "number", "boolean"].includes(typeof value),
          ),
        );
        return react.createElement(
          `x-${name}`,
          {
            "data-props": JSON.stringify(serializable),
            ...(rest.isDisabled ? { "data-disabled": "true" } : {}),
          },
          children as React.ReactNode,
        );
      },
    ]),
  );
});

let panel: PanelData;

beforeAll(async () => {
  panel = await fixtureBackend().getPanel({
    issueKey: "FS-42",
    issueId: "10042",
    projectKey: "FS",
  });
});

function props(overrides: Partial<PanelViewProps> = {}): PanelViewProps {
  return {
    result: { ok: true, mode: "fixture", data: panel },
    selectedCandidateId: panel.candidates[0]!.candidate.id,
    decision: "approved",
    notes: "Review note",
    submittingReview: false,
    confirmingReview: false,
    investigationNote: "",
    submittingInvestigation: false,
    onSelectCandidate: () => {},
    onDecisionChange: () => {},
    onNotesChange: () => {},
    onSubmitReview: () => {},
    onConfirmReview: () => {},
    onCloseReviewConfirmation: () => {},
    onCopySha: () => {},
    onInvestigationNoteChange: () => {},
    onExtraEnvironmentsChange: () => {},
    onRequestInvestigation: () => {},
    ...overrides,
  };
}

function markup(overrides: Partial<PanelViewProps> = {}) {
  return renderToStaticMarkup(
    React.createElement(PanelView, props(overrides)),
  );
}

describe("review panel view", () => {
  it("shows the fixture data label and redacts withheld case identifiers", () => {
    panel = {
      ...panel,
      candidates: panel.candidates.map((candidate) => ({
        ...candidate,
        suites: candidate.suites?.map((suite) =>
          suite.suite === "withheld"
            ? { ...suite, failedCaseIds: ["private-withheld-id"] }
            : suite,
        ),
      })),
    };
    const html = markup();
    expect(html).toContain("Sample data, not a real investigation");
    expect(html).toContain("Withheld checks");
    expect(html).toContain("7 of 8 passed");
    expect(html).not.toContain("private-withheld-id");
  });

  it("disables approval and explains a failed evaluation", () => {
    const failed = panel.candidates.find(
      ({ evaluation }) => evaluation?.status === "failed",
    )!;
    const html = markup({
      selectedCandidateId: failed.candidate.id,
    });
    expect(html).toContain("The evaluation has not passed yet");
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain("divider-approach-b");
  });

  it("shows evidence links only when an evidence pack URL exists", () => {
    expect(markup()).toContain("Download evidence pack");
    const { evidencePackUrl: _evidencePackUrl, ...links } = panel.links;
    const withoutEvidence = { ...panel, links };
    expect(
      markup({ result: { ok: true, mode: "fixture", data: withoutEvidence } }),
    ).not.toContain("Download evidence pack");
  });

  it("uses friendly unauthorized, empty, and unavailable-request copy", () => {
    expect(
      markup({
        result: { ok: false, code: "unauthorized", message: "secret" },
      }),
    ).toContain("Your Jira sign-in has expired");
    const emptyPanel = { ...panel, investigation: null };
    expect(
      markup({ result: { ok: true, mode: "fixture", data: emptyPanel } }),
    ).toContain("No ForkSafe investigation is linked to this issue yet.");
    expect(
      markup({
        investigationNote: "Please investigate",
        investigationResult: {
          ok: false,
          code: "not_available_yet",
          message: "raw",
        },
      }),
    ).toContain(
      "Asking for more investigation from Jira isn&#x27;t available yet.",
    );
  });
});
