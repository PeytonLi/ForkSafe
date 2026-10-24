import commentListFixture from "./fixtures/comment-list.json" with { type: "json" };
import confluencePage from "./fixtures/confluence-page.json" with { type: "json" };
import createFixture from "./fixtures/create.json" with { type: "json" };
import jiraIssueFixture from "./fixtures/jira-issue.json" with { type: "json" };
import myself from "./fixtures/myself.json" with { type: "json" };
import remoteLinkFixture from "./fixtures/remote-link.json" with { type: "json" };
import searchFixture from "./fixtures/search-jql.json" with { type: "json" };
import transitionsFixture from "./fixtures/transitions.json" with { type: "json" };
import type { AtlassianTransport } from "./http.js";

type MemoryIssue = {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  labels: string[];
  status: string;
  comments: Array<{ id: string; body: unknown }>;
  properties: Map<string, unknown>;
  remoteLinks: Map<string, unknown>;
};

const transitions = [
    {
      id: "21",
      name: "Start review",
      to: { name: "Ready for review" },
    },
    { id: "31", name: "Accept", to: { name: "Accepted" } },
];
const responseFixtures: Record<string, Record<string, unknown>> = {
  "comment-list": commentListFixture as unknown as Record<string, unknown>,
  "confluence-page": confluencePage as unknown as Record<string, unknown>,
  create: createFixture as unknown as Record<string, unknown>,
  "jira-issue": jiraIssueFixture as unknown as Record<string, unknown>,
  myself: myself as unknown as Record<string, unknown>,
  "remote-link": remoteLinkFixture as unknown as Record<string, unknown>,
  "search-jql": searchFixture as unknown as Record<string, unknown>,
  transitions: transitionsFixture as unknown as Record<string, unknown>,
};

export function fixtureTransport(): AtlassianTransport {
  const issues = new Map<string, MemoryIssue>();
  let nextIssue = 1;
  let nextComment = 1;
  return async ({ method, path, body }) => {
    const url = new URL(path, "https://fixture.invalid");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const jiraIssueIndex = segments.indexOf("issue");
    const issueKey = jiraIssueIndex >= 0 ? segments[jiraIssueIndex + 1] : undefined;
    let issue = issueKey ? issues.get(issueKey) : undefined;

    if (method === "GET" && url.pathname === "/rest/api/3/myself") {
      return { status: 200, body: fixture("myself") };
    }
    if (method === "GET" && url.pathname === "/wiki/api/v2/spaces") {
      return {
        status: 200,
        body: { results: [{ id: "fixture-space", name: "Fixture Space" }] },
      };
    }
    if (method === "GET" && /^\/wiki\/api\/v2\/pages\/[^/]+$/.test(url.pathname)) {
      return { status: 200, body: fixture("confluence-page") };
    }
    if (method === "POST" && url.pathname === "/rest/api/3/search/jql") {
      const query = (body as { jql?: string })?.jql ?? "";
      const matches = [...issues.values()].filter((candidate) => {
        const project = query.match(/project\s*=\s*"([^"]+)"/i)?.[1];
        const label = query.match(/labels\s*=\s*"([^"]+)"/i)?.[1];
        return (
          (!project || candidate.projectKey === project) &&
          (!label || candidate.labels.includes(label))
        );
      });
      return {
        status: 200,
        body: {
          ...fixture("search-jql"),
          issues: matches.map(toJiraIssue),
          total: matches.length,
        },
      };
    }
    if (method === "POST" && url.pathname === "/rest/api/3/issue") {
      const fields = (body as { fields?: Record<string, unknown> })?.fields ?? {};
      const projectKey = String((fields.project as { key?: string })?.key ?? "FS");
      const key = `${projectKey}-${nextIssue++}`;
      issue = {
        id: String(10000 + nextIssue),
        key,
        projectKey,
        summary: String(fields.summary ?? "ForkSafe investigation"),
        labels: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
        status: "Open",
        comments: [],
        properties: new Map(),
        remoteLinks: new Map(),
      };
      issues.set(key, issue);
      return { status: 201, body: { ...fixture("create"), id: issue.id, key } };
    }
    if (!issue && issueKey) return { status: 404, body: { error: "Issue not found" } };
    if (issue && method === "GET" && segments.length === jiraIssueIndex + 2) {
      return { status: 200, body: toJiraIssue(issue) };
    }
    if (issue && method === "PUT" && segments.length === jiraIssueIndex + 2) {
      const update = body as {
        fields?: { summary?: string; labels?: string[] };
        update?: { labels?: Array<{ add?: string }> };
      };
      if (update.fields?.summary) issue.summary = update.fields.summary;
      for (const label of update.fields?.labels ?? []) {
        if (!issue.labels.includes(label)) issue.labels.push(label);
      }
      for (const operation of update.update?.labels ?? []) {
        if (operation.add && !issue.labels.includes(operation.add)) {
          issue.labels.push(operation.add);
        }
      }
      return { status: 204, body: null };
    }
    if (issue && segments.at(-1) === "comment" && method === "GET") {
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const maxResults = Number(url.searchParams.get("maxResults") ?? 100);
      return {
        status: 200,
        body: {
          ...fixture("comment-list"),
          startAt,
          maxResults,
          total: issue.comments.length,
          comments: issue.comments.slice(startAt, startAt + maxResults),
        },
      };
    }
    if (issue && segments.at(-1) === "comment" && method === "POST") {
      const comment = {
        id: String(nextComment++),
        body: (body as { body?: unknown })?.body,
      };
      issue.comments.push(comment);
      return { status: 201, body: comment };
    }
    const propertyIndex = segments.indexOf("properties");
    if (issue && propertyIndex >= 0) {
      const propertyKey = segments[propertyIndex + 1] ?? "";
      if (method === "GET") {
        if (!issue.properties.has(propertyKey)) {
          return { status: 404, body: { error: "Property not found" } };
        }
        return { status: 200, body: { value: issue.properties.get(propertyKey) } };
      }
      if (method === "PUT") {
        issue.properties.set(propertyKey, (body as { value?: unknown })?.value);
        return { status: 200, body: {} };
      }
    }
    if (issue && segments.at(-1) === "remotelink" && method === "POST") {
      const link = body as { globalId?: string };
      const globalId = link.globalId ?? "";
      issue.remoteLinks.set(globalId, link);
      return { status: 200, body: { ...fixture("remote-link"), ...link } };
    }
    if (issue && segments.at(-1) === "transitions" && method === "GET") {
      return { status: 200, body: { ...fixture("transitions"), transitions } };
    }
    if (issue && segments.at(-1) === "transitions" && method === "POST") {
      const transitionId = (body as { transition?: { id?: string } })?.transition?.id;
      const selected = transitions.find((candidate) => candidate.id === transitionId);
      if (!selected) return { status: 400, body: { error: "Unknown transition" } };
      issue.status = selected.to?.name ?? selected.name;
      return { status: 204, body: null };
    }
    return { status: 404, body: { error: "Unknown fixture route" } };
  };
}

function fixture(name: string): Record<string, unknown> {
  const response = responseFixtures[name];
  if (!response) throw new Error(`Unknown recorded Atlassian fixture: ${name}`);
  return stripFixtureNote(response);
}

function stripFixtureNote(value: Record<string, unknown>): Record<string, unknown> {
  const { _fixture: _ignored, ...rest } = value;
  return rest;
}

function toJiraIssue(issue: MemoryIssue): Record<string, unknown> {
  const sample = fixture("jira-issue");
  const sampleFields = sample.fields as Record<string, unknown>;
  return {
    ...sample,
    id: issue.id,
    key: issue.key,
    fields: {
      ...sampleFields,
      summary: issue.summary,
      labels: [...issue.labels],
      status: { name: issue.status },
    },
  };
}
