import { invokeRemote } from "@forge/api";
import { PanelData } from "@forksafe/integrations-atlassian";
import { describe, expect, it, vi } from "vitest";
import { fixtureBackend, remoteBackend } from "../src/backend.js";
import { createHandlers, type ForgeContext } from "../src/handlers.js";

vi.mock("@forge/api", () => ({ invokeRemote: vi.fn() }));
vi.mock("@forge/bridge", () => ({ invoke: vi.fn() }));

const context: ForgeContext = {
  accountId: "account-42",
  extension: {
    issue: { key: "FS-42", id: "10042" },
    project: { key: "FS" },
  },
};

function remoteResponse(
  status: number,
  body?: unknown,
  isJson = true,
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: isJson
      ? vi.fn().mockResolvedValue(body)
      : vi.fn().mockRejectedValue(new SyntaxError("not JSON")),
  };
}

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
    ).toMatchObject({ ok: false, code: "backend_error" });
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

  it("requires an authenticated Jira account for reviews", async () => {
    const handlers = createHandlers(fixtureBackend());
    const result = await handlers.submitReview({
      payload: {
        investigationId: "00000000-0000-4000-8000-000000000101",
        candidateId: "00000000-0000-4000-8000-000000000121",
        evaluationId: "00000000-0000-4000-8000-000000000131",
        controllerSha256: "a".repeat(64),
        decision: "approved",
        notes: "Looks good.",
        submitKey: "00000000-0000-4000-8000-000000000201",
      },
      context: { ...context, accountId: undefined },
    });
    expect(result).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("maps remote authorization and version conflicts to friendly codes", async () => {
    const invokeRemoteMock = vi.mocked(invokeRemote);
    const handlers = createHandlers(remoteBackend());
    const payload = {
      investigationId: "00000000-0000-4000-8000-000000000101",
      candidateId: "00000000-0000-4000-8000-000000000121",
      evaluationId: "00000000-0000-4000-8000-000000000131",
      controllerSha256: "a".repeat(64),
      decision: "approved",
      notes: "Looks good.",
      submitKey: "00000000-0000-4000-8000-000000000201",
    };
    for (const [status, body, expectedCode] of [
      [401, { error: "unauthorized" }, "unauthorized"],
      [403, { error: "forbidden" }, "forbidden"],
      [409, { error: "sha_mismatch" }, "version_changed"],
    ] as const) {
      invokeRemoteMock.mockResolvedValueOnce(
        remoteResponse(status, body) as unknown as Awaited<
          ReturnType<typeof invokeRemote>
        >,
      );
      const result = await handlers.submitReview({ payload, context });
      expect(result).toMatchObject({ ok: false, code: expectedCode });
    }
  });

  it("distinguishes an absent request route from a JSON 404", async () => {
    const invokeRemoteMock = vi.mocked(invokeRemote);
    const handlers = createHandlers(remoteBackend());
    const payload = {
      investigationId: "00000000-0000-4000-8000-000000000101",
      note: "Please run another environment.",
      submitKey: "00000000-0000-4000-8000-000000000202",
    };
    invokeRemoteMock.mockResolvedValueOnce(
      remoteResponse(404, undefined, false) as unknown as Awaited<
        ReturnType<typeof invokeRemote>
      >,
    );
    expect(
      await handlers.requestMoreInvestigation({ payload, context }),
    ).toMatchObject({ ok: false, code: "not_available_yet" });
    invokeRemoteMock.mockResolvedValueOnce(
      remoteResponse(404, { error: "investigation_not_found" }) as unknown as Awaited<
        ReturnType<typeof invokeRemote>
      >,
    );
    expect(
      await handlers.requestMoreInvestigation({ payload, context }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("removes withheld case identifiers from panel and review details", async () => {
    const backend = fixtureBackend();
    const getPanel = backend.getPanel.bind(backend);
    backend.getPanel = async (request) => {
      const panel = await getPanel(request);
      return {
        ...panel,
        candidates: panel.candidates.map((candidate) => ({
          ...candidate,
          suites: candidate.suites?.map((suite) =>
            suite.suite === "withheld"
              ? { ...suite, failedCaseIds: ["private-withheld-case"] }
              : suite,
          ),
        })),
      };
    };
    const getReviewContext = backend.getReviewContext.bind(backend);
    backend.getReviewContext = async (request) => {
      const details = await getReviewContext(request);
      return {
        ...details,
        evaluation: {
          ...details.evaluation,
          cases: [
            ...details.evaluation.cases,
            {
              caseId: "private-withheld-case",
              status: "failed" as const,
              failureKinds: [],
            },
          ],
        },
      };
    };
    const handlers = createHandlers(backend);
    const panel = await handlers.getPanel({ payload: {}, context });
    expect(panel.ok).toBe(true);
    if (panel.ok) {
      const withheld = panel.data.candidates
        .flatMap((candidate) => candidate.suites ?? [])
        .find((suite) => suite.suite === "withheld");
      expect(withheld).not.toHaveProperty("failedCaseIds");
    }
    const details = await handlers.getReviewDetails({
      payload: {
        investigationId: "00000000-0000-4000-8000-000000000101",
        candidateId: "00000000-0000-4000-8000-000000000121",
        evaluationId: "00000000-0000-4000-8000-000000000131",
      },
      context,
    });
    expect(details.ok).toBe(true);
    if (details.ok) {
      expect(details.data.evaluation).not.toHaveProperty("failedCaseIds");
      expect(details.data.evaluation).not.toHaveProperty("cases");
      expect(JSON.stringify(details.data)).not.toContain("private-withheld-case");
    }
  });
});
