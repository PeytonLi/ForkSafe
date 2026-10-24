import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api.js";
import schema from "../schema.js";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("../**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\.\//, ""), load]),
);
modules["dispatchers/jira.ts"] = () => import("./jira.js");
const serviceToken = "convex-test-service-token";

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

describe("Jira investigation snapshot query", () => {
  beforeEach(() => vi.stubEnv("INTEGRATION_SHARED_SECRET", serviceToken));
  afterEach(() => vi.unstubAllEnvs());

  it("returns the latest Convex investigation for a Jira issue key", async () => {
    const t = createTest();
    const first = await t.mutation(api.investigations.create, {
      title: "Older investigation",
      jiraIssueKey: "FS-42",
      idempotencyKey: "jira-snapshot-older",
      serviceToken,
    });
    const second = await t.mutation(api.investigations.create, {
      title: "Latest investigation",
      jiraIssueKey: "FS-42",
      idempotencyKey: "jira-snapshot-latest",
      serviceToken,
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("investigations").collect();
      const older = rows.find((row) => row.appId === first.investigationId)!;
      const latest = rows.find((row) => row.appId === second.investigationId)!;
      await ctx.db.patch(older._id, { updatedAtMs: 10 });
      await ctx.db.patch(latest._id, { updatedAtMs: 20 });
    });

    await expect(t.query(internal.dispatchers.jira.getInvestigation, {
      jiraIssueKey: "FS-42",
    })).resolves.toMatchObject({
      investigation: {
        id: second.investigationId,
        title: "Latest investigation",
        state: "capturing",
      },
      environments: [],
    });
  });

  it("dead-letters the matching pending Jira receipt without changing completed rows", async () => {
    const t = createTest();
    const key = "review:11111111-1111-4111-8111-111111111111:jira_sync";
    const pending = await t.run((ctx) => ctx.db.insert("outbox", {
      appId: "11111111-1111-4111-8111-111111111111",
      destination: "jira_sync",
      status: "pending",
      idempotencyKey: key,
      operationId: "22222222-2222-4222-8222-222222222222",
      payload: { kind: "review", id: "11111111-1111-4111-8111-111111111111" },
      attempts: 0,
      createdAtMs: 1,
      source: "spacetimedb",
      nextAttemptAtMs: 1,
    }));

    expect(await t.mutation(internal.dispatchers.jira.deadLetter, {
      idempotencyKey: key,
      errorCode: "jira_http_400",
    })).toEqual({ updated: true });
    expect(await t.run((ctx) => ctx.db.get(pending))).toMatchObject({
      status: "dead",
      lastError: "jira_http_400",
    });
  });
});
