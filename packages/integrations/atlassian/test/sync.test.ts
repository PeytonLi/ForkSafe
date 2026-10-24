import { describe, expect, it } from "vitest";
import { fixtureTransport } from "../src/fixture-transport.js";
import { JiraClient } from "../src/jira.js";
import {
  investigationLabel,
  jiraSyncIdempotencyKey,
  opMarker,
  remoteLinkGlobalId,
  syncFromOutbox,
  syncInvestigationToJira,
  issueBodyLines,
  type JiraSyncInput,
} from "../src/sync.js";
import type { AtlassianTransport } from "../src/http.js";

const investigationId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const candidateId = "00000000-0000-4000-8000-000000000003";
const sha = "a".repeat(64);

function input(overrides: Partial<JiraSyncInput> = {}): JiraSyncInput {
  return {
    operationId,
    projectKey: "FS",
    investigation: {
      id: investigationId,
      state: "searching",
      title: "Divider contact",
      baselineCase: {
        caseId: "baseline",
        suite: "original",
        seed: 1,
        sceneOverrides: {},
      },
      baselineExperimentId: "00000000-0000-4000-8000-000000000004",
      requestedEnvironments: 3,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    summary: {
      activeEnvironments: 2,
      findingsCount: 4,
      candidatesCount: 1,
      bestEvaluation: {
        candidateId,
        controllerSha256: sha,
        status: "passed",
        allRequiredPassed: true,
        passedCases: 5,
        totalCases: 5,
      },
    },
    investigationUrl: "https://forksafe.example.invalid/investigations/demo",
    ...overrides,
  };
}

function countedTransport(
  base: AtlassianTransport = fixtureTransport(),
): { transport: AtlassianTransport; calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = [];
  return {
    calls,
    transport: async (request) => {
      calls.push({ method: request.method, path: request.path });
      return base(request);
    },
  };
}

describe("Jira investigation sync", () => {
  it("creates one issue, marks comments by operation, and retries idempotently", async () => {
    const counted = countedTransport();
    const client = new JiraClient(counted.transport);
    const first = await syncInvestigationToJira(client, input());
    expect(first.created).toBe(true);
    expect(first.commentAdded).toBe(true);
    expect(first.remoteLinkUpserted).toBe(true);
    expect(counted.calls.filter((call) => call.path === "/rest/api/3/issue").length).toBe(1);
    expect(
      counted.calls.filter((call) => call.path.endsWith("/comment") && call.method === "POST"),
    ).toHaveLength(1);
    expect(counted.calls.filter((call) => call.path.endsWith("/remotelink"))).toHaveLength(1);

    const second = await syncInvestigationToJira(client, input());
    expect(second.created).toBe(false);
    expect(second.commentAdded).toBe(false);
    expect(counted.calls.filter((call) => call.path === "/rest/api/3/issue")).toHaveLength(1);
    expect(
      counted.calls.filter((call) => call.path.endsWith("/comment") && call.method === "POST"),
    ).toHaveLength(1);

    const newOperation = "00000000-0000-4000-8000-000000000005";
    const third = await syncInvestigationToJira(
      client,
      input({ operationId: newOperation }),
    );
    expect(third.commentAdded).toBe(true);
    expect(counted.calls.filter((call) => call.path === "/rest/api/3/issue")).toHaveLength(1);
    expect(opMarker(newOperation)).toContain(newOperation);
    expect(investigationLabel(investigationId)).toBe(`forksafe-inv-${investigationId}`);
    expect(remoteLinkGlobalId(investigationId)).toBe(
      `forksafe:investigation:${investigationId}`,
    );
    expect(jiraSyncIdempotencyKey(investigationId)).toBe(`jira_sync:${investigationId}`);
  });

  it("reconciles a create response lost after Jira accepted the issue", async () => {
    const base = fixtureTransport();
    const calls: string[] = [];
    let loseCreateResponse = true;
    const transport: AtlassianTransport = async (request) => {
      calls.push(`${request.method} ${request.path}`);
      const response = await base(request);
      if (request.method === "POST" && request.path === "/rest/api/3/issue" && loseCreateResponse) {
        loseCreateResponse = false;
        throw new Error("simulated network loss");
      }
      return response;
    };
    const client = new JiraClient(transport);
    await expect(syncInvestigationToJira(client, input())).rejects.toThrow(
      "simulated network loss",
    );
    const retry = await syncInvestigationToJira(client, input());
    expect(retry.reconciled).toBe(true);
    expect(retry.created).toBe(false);
    expect(calls.filter((call) => call === "POST /rest/api/3/issue")).toHaveLength(1);
    expect(retry.issueKey).toBe("FS-1");
  });

  it("uses a Jira issue key without searching or creating", async () => {
    const counted = countedTransport();
    const client = new JiraClient(counted.transport);
    await syncInvestigationToJira(client, input());
    counted.calls.length = 0;
    await syncInvestigationToJira(
      client,
      input({
        investigation: {
          ...input().investigation,
          jiraIssueKey: "FS-1",
        },
      }),
    );
    expect(counted.calls.some((call) => call.path === "/rest/api/3/search/jql")).toBe(false);
    expect(counted.calls.some((call) => call.path === "/rest/api/3/issue")).toBe(false);
  });

  it("gates project-configured workflow transitions on evidence and mapping", async () => {
    const unready = countedTransport();
    await syncInvestigationToJira(new JiraClient(unready.transport), input({
      investigation: { ...input().investigation, state: "searching" },
      workflow: { readyForReview: { statusNames: ["Ready for review"] } },
    }));
    expect(unready.calls.some((call) => call.path.endsWith("/transitions") && call.method === "POST")).toBe(false);

    const ready = countedTransport();
    const result = await syncInvestigationToJira(new JiraClient(ready.transport), input({
      investigation: { ...input().investigation, state: "awaiting_review" },
      workflow: { readyForReview: { statusNames: ["ready for review"] } },
    }));
    expect(result.transition.applied).toBe(true);
    expect(ready.calls.filter((call) => call.path.endsWith("/transitions") && call.method === "POST")).toHaveLength(1);

    const noMatch = countedTransport();
    const noMatchResult = await syncInvestigationToJira(new JiraClient(noMatch.transport), input({
      investigation: { ...input().investigation, state: "awaiting_review" },
      workflow: { readyForReview: { statusNames: ["Unknown status"] } },
    }));
    expect(noMatchResult.transition).toMatchObject({
      applied: false,
      reason: "no_matching_transition",
      available: ["Start review", "Ready for review", "Accept", "Accepted"],
    });
    expect(noMatch.calls.some((call) => call.path.endsWith("/transitions") && call.method === "POST")).toBe(false);
  });

  it("rejects outbox entries for another destination or operation", async () => {
    const client = new JiraClient(fixtureTransport());
    const baseEntry = {
      id: "00000000-0000-4000-8000-000000000006",
      status: "pending" as const,
      idempotencyKey: jiraSyncIdempotencyKey(investigationId),
      operationId,
      payload: input(),
      attempts: 0,
      createdAtMs: 1,
    };
    await expect(
      syncFromOutbox(client, { ...baseEntry, destination: "elastic_index" }),
    ).rejects.toThrow("destination must be jira_sync");
    await expect(
      syncFromOutbox(client, {
        ...baseEntry,
        destination: "jira_sync",
        operationId: "00000000-0000-4000-8000-000000000007",
      }),
    ).rejects.toThrow("operationId does not match");
  });
});

describe("Jira issue body", () => {
  it("lists every candidate verdict and the review decision without withheld case detail", () => {
    const lines = issueBodyLines(input({
      candidateVerdicts: [{
        candidateId, controllerSha256: sha, publicVerdict: "passed", publicPassed: 4, publicTotal: 4, withheldVerdict: "failed",
      }],
      review: { reviewId: operationId, candidateId, decision: "accepted" },
    }));
    const text = lines.join("\n");
    expect(text).toContain(`Candidate ${candidateId}`);
    expect(text).toContain("public passed 4/4; withheld failed");
    expect(text).toContain(`Review decision: accepted for candidate ${candidateId}`);
    expect(text).not.toMatch(/withheld-\d|withheld \d+\/\d+|sceneOverrides|seed/i);
  });

  it("says pending when there is no review or evaluated candidate yet", () => {
    const text = issueBodyLines(input()).join("\n");
    expect(text).toContain("Candidates: none evaluated yet");
    expect(text).toContain("Review decision: pending");
  });

  it("rejects malformed labels and review decisions at the boundary", async () => {
    await expect(syncInvestigationToJira({} as JiraClient, input({ extraLabels: ["bad label"] }))).rejects.toThrow();
    await expect(syncInvestigationToJira({} as JiraClient, input({ review: { reviewId: operationId, candidateId, decision: "<script>" } }))).rejects.toThrow();
  });
});

