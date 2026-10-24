import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api.js";
import schema from "../schema.js";
import { JiraClient } from "../../packages/integrations/atlassian/src/index.js";
import { deliverAndLinkJiraPayload } from "./jira.js";

const investigationId = "11111111-1111-4111-8111-111111111111";
const unknownInvestigationId = "22222222-2222-4222-8222-222222222222";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("../**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\.\//, ""), load]),
);
modules["dispatchers/jira.ts"] = () => import("./jira.js");

function createTest() {
  return convexTest(schema, modules);
}

async function seedInvestigation(
  t: ReturnType<typeof createTest>,
  id = investigationId,
  jiraIssueKey?: string,
) {
  return await t.run((ctx) => ctx.db.insert("investigations", {
    appId: id,
    title: "Investigate contact",
    state: "capturing",
    cancelStatus: "none",
    cancelEpoch: 0,
    version: 1,
    requestedEnvironments: 1,
    baselineCase: { caseId: "33333333-3333-4333-8333-333333333333", suite: "original", seed: 1, sceneOverrides: {} },
    baselineExperimentId: "44444444-4444-4444-8444-444444444444",
    ...(jiraIssueKey ? { jiraIssueKey } : {}),
    budget: {
      wallTimeMs: 600_000,
      maxExperimentsPerEnv: 20,
      maxCandidatesPerEnv: 2,
      maxFinalCandidates: 3,
    },
    idempotencyKey: `test:${id}`,
    createdAtMs: 100,
    updatedAtMs: 100,
  }));
}

function jiraClientReturningFs9(investigationId: string): JiraClient {
  const labels = [`forksafe-inv-${investigationId}`, "forksafe-run"];
  return new JiraClient(async ({ method, path }) => {
    if (method === "POST" && path === "/rest/api/3/search/jql") {
      return { status: 200, body: { issues: [] } };
    }
    if (method === "POST" && path === "/rest/api/3/issue") {
      return { status: 201, body: { id: "9", key: "FS-9" } };
    }
    if (method === "GET" && path.startsWith("/rest/api/3/issue/FS-9?")) {
      return {
        status: 200,
        body: { id: "9", key: "FS-9", fields: { status: { name: "To Do" }, labels } },
      };
    }
    if (method === "GET" && path.includes("/comment?")) {
      return { status: 200, body: { comments: [], total: 0 } };
    }
    if (method === "POST" && path.endsWith("/comment")) {
      return { status: 201, body: {} };
    }
    if (method === "GET" && path.includes("/properties/")) {
      return { status: 404, body: { message: "not found" } };
    }
    if (method === "PUT" && path.includes("/properties/")) {
      return { status: 200, body: {} };
    }
    return { status: 404, body: { message: "not found" } };
  });
}

describe("linkJiraIssue mutation", () => {
  it("sets the key and bumps updatedAtMs when the investigation is unlinked", async () => {
    const t = createTest();
    await seedInvestigation(t);

    await expect(t.mutation(internal.investigations.linkJiraIssue, {
      investigationId,
      jiraIssueKey: "FS-9",
    })).resolves.toEqual({ linked: true });
    const updated = await t.run((ctx) => ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", investigationId))
      .unique());
    expect(updated?.jiraIssueKey).toBe("FS-9");
    expect(updated?.updatedAtMs).toBeGreaterThan(100);
  });

  it("reports an already-linked key without changing it", async () => {
    const t = createTest();
    await seedInvestigation(t, investigationId, "FS-9");

    await expect(t.mutation(internal.investigations.linkJiraIssue, {
      investigationId,
      jiraIssueKey: "FS-9",
    })).resolves.toEqual({ linked: false, reason: "already_linked" });
  });

  it("does not overwrite a different key", async () => {
    const t = createTest();
    await seedInvestigation(t, investigationId, "FS-3");

    await expect(t.mutation(internal.investigations.linkJiraIssue, {
      investigationId,
      jiraIssueKey: "FS-4",
    })).resolves.toEqual({ linked: false, reason: "conflict" });
    await expect(t.run((ctx) => ctx.db.query("investigations")
      .withIndex("by_appId", (q) => q.eq("appId", investigationId))
      .unique())).resolves.toMatchObject({ jiraIssueKey: "FS-3" });
  });

  it("rejects keys with an invalid format", async () => {
    const t = createTest();
    await seedInvestigation(t);

    await expect(t.mutation(internal.investigations.linkJiraIssue, {
      investigationId,
      jiraIssueKey: "fs-9",
    })).rejects.toThrow("jira_issue_key_invalid");
  });

  it("reports a missing investigation", async () => {
    const t = createTest();

    await expect(t.mutation(internal.investigations.linkJiraIssue, {
      investigationId: unknownInvestigationId,
      jiraIssueKey: "FS-9",
    })).resolves.toEqual({ linked: false, reason: "missing" });
  });
});

describe("Jira delivery issue linking", () => {
  it("makes the delivered issue discoverable by the lookup used by the Forge panel", async () => {
    const t = createTest();
    await seedInvestigation(t);
    const delivery = await deliverAndLinkJiraPayload(
      { kind: "awaiting_review", investigationId },
      {
        client: jiraClientReturningFs9(investigationId),
        spacetime: {
          listCandidates: async () => [],
          listEvaluations: async () => [],
          findingsCount: async () => 0,
        } as never,
        snapshot: (query) => t.query(internal.dispatchers.jira.getInvestigation, query),
        projectKey: "FS",
        siteUrl: "https://jira.example.invalid",
        linkJiraIssue: (args) => t.mutation(internal.investigations.linkJiraIssue, args),
      },
    );

    expect(delivery).toMatchObject({ result: { issueKey: "FS-9" } });
    await expect(t.query(internal.dispatchers.jira.getInvestigation, {
      jiraIssueKey: "FS-9",
    })).resolves.toMatchObject({ investigation: { id: investigationId } });
  });

  it("does not turn a successful delivery into a failure when linking throws", async () => {
    const t = createTest();
    await seedInvestigation(t);
    const log = vi.fn();

    const delivery = await deliverAndLinkJiraPayload(
      { kind: "awaiting_review", investigationId },
      {
        client: jiraClientReturningFs9(investigationId),
        spacetime: {
          listCandidates: async () => [],
          listEvaluations: async () => [],
          findingsCount: async () => 0,
        } as never,
        snapshot: (query) => t.query(internal.dispatchers.jira.getInvestigation, query),
        projectKey: "FS",
        siteUrl: "https://jira.example.invalid",
        linkJiraIssue: async () => { throw new Error("private link failure"); },
        log,
      },
    );

    expect(delivery).toMatchObject({ result: { issueKey: "FS-9" } });
    expect(log).toHaveBeenCalledWith("jira:link_failed");
    expect(log.mock.calls.flat().join(" ")).not.toContain("private link failure");
  });

  it("does not try to persist a key for a remote Confluence link", async () => {
    const linkJiraIssue = vi.fn();
    const result = await deliverAndLinkJiraPayload(
      { destination: "confluence_link", investigationId, pageId: "12345" },
      {
        client: { upsertRemoteLink: async () => ({}) } as unknown as JiraClient,
        spacetime: {} as never,
        snapshot: async () => ({
          investigation: {
            id: investigationId,
            state: "awaiting_review",
            title: "Investigate contact",
            baselineCase: { caseId: "baseline-1", suite: "public", seed: 3, sceneOverrides: {} },
            baselineExperimentId: "44444444-4444-4444-8444-444444444444",
            requestedEnvironments: 1,
            createdAtMs: 10,
            updatedAtMs: 20,
            jiraIssueKey: "FS-9",
          },
          environments: [],
        }),
        projectKey: "FS",
        siteUrl: "https://jira.example.invalid",
        linkJiraIssue,
      },
    );

    expect(result).toEqual({ remoteLinked: true });
    expect(linkJiraIssue).not.toHaveBeenCalled();
  });
});

describe("Jira issue link backfill", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("links the earliest issue, counts a conflict, and reports an unknown investigation", async () => {
    const t = createTest();
    await seedInvestigation(t);
    const issues = [
      { id: "3", key: "FS-3", fields: { labels: ["forksafe-run", `forksafe-inv-${investigationId}`] } },
      { id: "4", key: "FS-4", fields: { labels: ["forksafe-run", `forksafe-inv-${investigationId}`] } },
      { id: "9", key: "FS-9", fields: { labels: ["forksafe-run", `forksafe-inv-${unknownInvestigationId}`] } },
    ];
    let requestBody: Record<string, unknown> | undefined;
    vi.stubEnv("ATLASSIAN_MODE", "cloud");
    vi.stubEnv("ATLASSIAN_SITE_URL", "https://jira.example.invalid");
    vi.stubEnv("ATLASSIAN_EMAIL", "test@example.invalid");
    vi.stubEnv("ATLASSIAN_API_TOKEN", "dummy-token");
    vi.stubEnv("ATLASSIAN_PROJECT_KEY", "FS");
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ issues }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(t.action(internal.dispatchers.jira.backfillJiraIssueLinks, {})).resolves.toEqual({
      scanned: 3,
      linked: 1,
      alreadyLinked: 0,
      conflicts: 1,
      missing: 1,
    });
    expect(requestBody).toEqual({
      jql: 'project = "FS" AND labels = "forksafe-run" ORDER BY created ASC',
      fields: ["labels"],
      maxResults: 1000,
    });
    await expect(t.query(internal.dispatchers.jira.getInvestigation, {
      jiraIssueKey: "FS-3",
    })).resolves.toMatchObject({ investigation: { id: investigationId } });
  });
});
