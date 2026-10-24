import { describe, expect, it } from "vitest";
import { AtlassianHttpError, JiraClient } from "../../packages/integrations/atlassian/src/index.js";
import {
  classifyJiraFailure,
  deliverJiraPayload,
  operationIdForIdempotencyKey,
} from "./jira.js";
import { SpacetimeRejected } from "./spacetime.js";

const investigationId = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const evaluationId = "33333333-3333-4333-8333-333333333333";
const reviewId = "44444444-4444-4444-8444-444444444444";
const investigation = {
  id: investigationId,
  state: "awaiting_review",
  title: "Investigate contact",
  baselineCase: { caseId: "baseline-1", suite: "public", seed: 3, sceneOverrides: {} },
  baselineExperimentId: "55555555-5555-4555-8555-555555555555",
  requestedEnvironments: 1,
  createdAtMs: 10,
  updatedAtMs: 20,
};
const candidate = {
  id: candidateId,
  controllerSha256: "a".repeat(64),
};
const evaluation = {
  id: evaluationId,
  candidateId,
  investigationId,
  evaluatorAttemptId: "66666666-6666-4666-8666-666666666666",
  suite: "public",
  cases: [{ caseId: "case-1", status: "passed", failureKinds: [] }],
  allRequiredPassed: true,
  status: "passed",
  createdAtMs: 30,
};

function jiraFixture(loseFirstCreateResponse = true) {
  const issues = new Map<string, { id: string; key: string; labels: string[]; status: string }>();
  const comments = new Map<string, unknown[]>();
  const properties = new Map<string, unknown>();
  const remoteLinks = new Map<string, unknown>();
  const transitions = new Map<string, string>();
  let createResponseLost = loseFirstCreateResponse;
  let nextIssue = 1;
  const transport = async ({ method, path, body }: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown }) => {
    if (path === "/rest/api/3/search/jql" && method === "POST") {
      const labels = (body as { jql: string }).jql.match(/labels = "([^"]+)"/)?.[1];
      return {
        status: 200,
        body: { issues: [...issues.values()].filter((issue) => issue.labels.includes(labels ?? "")) },
      };
    }
    if (path === "/rest/api/3/issue" && method === "POST") {
      const fields = (body as { fields: { labels?: string[]; summary: string } }).fields;
      const issue = { id: String(nextIssue), key: `FS-${nextIssue++}`, labels: fields.labels ?? [], status: "To Do" };
      issues.set(issue.key, issue);
      comments.set(issue.key, []);
      if (createResponseLost) {
        createResponseLost = false;
        throw new Error("private network details");
      }
      return { status: 201, body: { id: issue.id, key: issue.key } };
    }
    const issueRoute = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)/);
    const issueKey = issueRoute?.[1];
    if (issueKey && method === "GET" && path.includes("/comment?")) {
      return { status: 200, body: { comments: comments.get(issueKey) ?? [], total: comments.get(issueKey)?.length ?? 0 } };
    }
    if (issueKey && method === "POST" && path.endsWith("/comment")) {
      const list = comments.get(issueKey) ?? [];
      list.push({ body: (body as { body: unknown }).body });
      comments.set(issueKey, list);
      return { status: 201, body: {} };
    }
    if (issueKey && method === "POST" && path.endsWith("/remotelink")) {
      const globalId = (body as { globalId: string }).globalId;
      remoteLinks.set(globalId, body);
      return { status: 201, body: {} };
    }
    if (issueKey && method === "GET" && path.includes("/properties/")) {
      const property = path.split("/properties/")[1] ?? "";
      if (!properties.has(property)) return { status: 404, body: { message: "not found" } };
      return { status: 200, body: { value: properties.get(property) } };
    }
    if (issueKey && method === "PUT" && path.includes("/properties/")) {
      properties.set(path.split("/properties/")[1]!, (body as { value: unknown }).value);
      return { status: 200, body: {} };
    }
    if (issueKey && method === "GET" && path.endsWith("/transitions")) {
      return { status: 200, body: { transitions: [{ id: "3", name: "Start progress", to: { name: "In Progress" } }] } };
    }
    if (issueKey && method === "POST" && path.endsWith("/transitions")) {
      transitions.set(issueKey, "In Progress");
      const issue = issues.get(issueKey);
      if (issue) issue.status = "In Progress";
      return { status: 204, body: null };
    }
    if (issueKey && issues.has(issueKey) && method === "GET") {
      const issue = issues.get(issueKey)!;
      return { status: 200, body: { id: issue.id, key: issue.key, fields: { status: { name: transitions.get(issueKey) ?? issue.status }, labels: issue.labels } } };
    }
    if (issueKey && issues.has(issueKey) && method === "PUT") {
      const issue = issues.get(issueKey)!;
      const added = (body as { update?: { labels?: Array<{ add: string }> } }).update?.labels ?? [];
      issue.labels.push(...added.map((item) => item.add).filter((label) => !issue.labels.includes(label)));
      return { status: 204, body: null };
    }
    return { status: 404, body: { message: "not found" } };
  };
  return { client: new JiraClient(transport), issues, comments, properties, remoteLinks, transitions };
}

describe("Jira outbox dispatcher", () => {
  it("derives a stable UUIDv5-style operation id from the idempotency key", async () => {
    const first = await operationIdForIdempotencyKey("review:123:jira_sync");
    expect(first).toBe(await operationIdForIdempotencyKey("review:123:jira_sync"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("adopts an issue when create succeeded but its response was lost, and deduplicates comments", async () => {
    const jira = jiraFixture();
    const deps = {
      client: jira.client,
      spacetime: {
        getReview: async () => ({
          id: reviewId,
          investigationId,
          candidateId,
          evaluationId,
          controllerSha256: candidate.controllerSha256,
          decision: "approve",
          reviewerIdentity: "atlassian:reviewer",
          createdAtMs: 40,
        }),
        listCandidates: async () => [candidate],
        listEvaluations: async () => [evaluation],
        findingsCount: async () => 2,
      },
      snapshot: async () => ({ investigation, environments: [{ state: "active" }] }),
      projectKey: "FS",
      siteUrl: "https://jira.example.invalid",
      webUrl: "https://forksafe.example.invalid",
      readyStatuses: ["In Progress"],
    } as unknown as Parameters<typeof deliverJiraPayload>[1];

    await expect(deliverJiraPayload({ kind: "review", id: reviewId }, deps)).rejects.toThrow();
    const second = await deliverJiraPayload({ kind: "review", id: reviewId }, deps);
    const third = await deliverJiraPayload({ kind: "review", id: reviewId }, deps);

    expect(jira.issues.size).toBe(1);
    expect(jira.comments.get("FS-1")).toHaveLength(1);
    expect(jira.remoteLinks.size).toBe(1);
    expect(jira.transitions.get("FS-1")).toBe("In Progress");
    expect(second).toMatchObject({ input: { projectKey: "FS", summary: { findingsCount: 2 } } });
    expect((second as { input: { operationId: string } }).input.operationId)
      .toBe((third as { input: { operationId: string } }).input.operationId);
  });

  it("classifies only bad requests and missing resources as permanent", () => {
    expect(classifyJiraFailure(new AtlassianHttpError(400, "POST", "/issue", "bad request"))).toMatchObject({
      permanent: true,
      code: "jira_http_400",
    });
    expect(classifyJiraFailure(new AtlassianHttpError(404, "GET", "/issue", "not found")).permanent).toBe(true);
    for (const status of [401, 403, 429, 500]) {
      expect(classifyJiraFailure(new AtlassianHttpError(status, "GET", "/issue", "private details")).permanent).toBe(false);
    }
    expect(classifyJiraFailure(new SpacetimeRejected("duplicate_id")).permanent).toBe(true);
    expect(JSON.stringify(classifyJiraFailure(new AtlassianHttpError(403, "GET", "/issue", "token=private"))))
      .not.toContain("private");
  });

  it("upserts a deterministic Confluence remote link on redelivery", async () => {
    const jira = jiraFixture(false);
    await jira.client.createIssue({
      projectKey: "FS",
      summary: "Investigation",
      description: { type: "doc", version: 1, content: [] },
      labels: [`forksafe-inv-${investigationId}`],
    });
    const payload = { destination: "confluence_link", investigationId, pageId: "12345" };
    const deps = {
      client: jira.client,
      spacetime: {
        getReview: async () => null,
        listCandidates: async () => [],
        listEvaluations: async () => [],
        findingsCount: async () => 0,
      },
      snapshot: async () => ({ investigation: { ...investigation, jiraIssueKey: "FS-1" }, environments: [] }),
      projectKey: "FS",
      siteUrl: "https://jira.example.invalid",
    } as unknown as Parameters<typeof deliverJiraPayload>[1];

    await deliverJiraPayload(payload, deps);
    await deliverJiraPayload(payload, deps);

    expect(jira.remoteLinks.size).toBe(1);
    expect([...jira.remoteLinks.keys()]).toEqual([`forksafe:confluence:${investigationId}:12345`]);
  });
});
