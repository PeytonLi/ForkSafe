import { PanelData } from "@forksafe/integrations-atlassian";
import { describe, expect, it, vi } from "vitest";
import { fixtureBackend } from "../src/backend.js";
import { createHandlers, type ForgeContext } from "../src/handlers.js";

vi.mock("@forge/api", () => ({ invokeRemote: vi.fn() }));
vi.mock("@forge/bridge", () => ({ invoke: vi.fn() }));

const context: ForgeContext = {
  extension: {
    issue: { key: "FS-42", id: "10042" },
    project: { key: "FS" },
  },
};

describe("Forge resolver handlers", () => {
  it("returns valid fixture panel data with traceable candidates", async () => {
    const handlers = createHandlers(fixtureBackend());
    const result = await handlers.getPanel({ payload: { issueKey: "IGNORED" }, context });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("fixture");
      expect(PanelData.parse(result.data)).toEqual(result.data);
      expect(result.data.issue).toEqual({ key: "FS-42", id: "10042" });
      expect(result.data.candidates.every(({ candidate }) =>
        /^[0-9a-f]{64}$/i.test(candidate.controllerSha256),
      )).toBe(true);
    }
  });

  it("requires Jira issue and project context and validates environment bounds", async () => {
    const handlers = createHandlers(fixtureBackend());
    expect(
      await handlers.getPanel({ payload: {}, context: {} }),
    ).toMatchObject({ ok: false, code: "no_issue_context" });
    expect(
      await handlers.startInvestigation({
        payload: { requestedEnvironments: 11 },
        context,
      }),
    ).toMatchObject({ ok: false, code: "invalid_request" });
    const started = await handlers.startInvestigation({
      payload: { requestedEnvironments: 5, title: "Issue-specific investigation" },
      context,
    });
    expect(started).toMatchObject({
      ok: true,
      mode: "fixture",
      data: { state: "capturing" },
    });
  });
});
