import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("./**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\//, ""), load]),
);

const investigationId = "11111111-1111-4111-8111-111111111111";
const otherInvestigation = "99999999-9999-4999-8999-999999999999";
const envA = "22222222-2222-4222-8222-222222222222";
const envB = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const credentialId = "55555555-5555-4555-8555-555555555555";
const revisionId = "66666666-6666-4666-8666-666666666666";
const findingA = "77777777-7777-4777-8777-777777777777";
const findingB = "88888888-8888-4888-8888-888888888888";

function finding(appId: string, environmentId: string, createdAtMs: number, inv = investigationId) {
  return {
    appId, investigationId: inv, environmentId, attemptId, epoch: 1, kind: "limit_violation" as const,
    claim: "observation" as const, summary: `finding ${appId}`, evidence: [{ kind: "metric" as const, locator: {} }],
    spacetimeCommitted: true, createdAtMs,
  };
}

describe("finding requirements before candidate submission", () => {
  it("counts only this environment's findings in this investigation and returns the revision's citations", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("findings", finding(findingA, envA, 1));
      await ctx.db.insert("findings", finding("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", envB, 2, otherInvestigation));
      await ctx.db.insert("controllerRevisions", {
        appId: revisionId, investigationId, environmentId: envB, seq: 1, controllerSha256: "a".repeat(64),
        sourceArtifactId: attemptId, changedFunctions: ["plan"], basedOnFindings: [findingA], createdByAttemptId: attemptId,
        epoch: 1, spacetimeCommitted: true, createdAtMs: 3,
      });
    });
    const forB = await t.query(internal.agentTools.candidatePreconditions, { investigationId, environmentId: envB, revisionId });
    expect(forB).toEqual({ environmentFindings: 0, revisionFindings: [findingA] });
    const forA = await t.query(internal.agentTools.candidatePreconditions, { investigationId, environmentId: envA, revisionId });
    expect(forA).toEqual({ environmentFindings: 1, revisionFindings: [] });
  });

  it("read_findings lists the other environment's findings first and tells an environment with none that one is required", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("runnerCredentials", {
        appId: credentialId, investigationId, environmentId: envB, secret: "hash", expiresAtMs: Date.now() + 60_000, createdAtMs: 1,
      });
      await ctx.db.insert("findings", finding(findingA, envA, 1));
    });
    const args = { credentialId, investigationId, environmentId: envB, sessionId: attemptId, attemptId, grantId: attemptId, epoch: 1, scope: "investigation" as const, limit: 10 };
    const first = await t.query(internal.agentTools.readFindings, args);
    expect(first).toMatchObject({ ownEnvironmentFindings: 0, otherEnvironmentFindings: 1, findings: [{ id: findingA, fromThisEnvironment: false }] });
    expect(first.required).toContain("write_finding");
    await t.run(async (ctx) => { await ctx.db.insert("findings", finding(findingB, envB, 5)); });
    const second = await t.query(internal.agentTools.readFindings, args);
    expect(second.findings.map((row: { id: string }) => row.id)).toEqual([findingA, findingB]);
    expect(second.required).toBeUndefined();
  });

  it("read_findings fails closed for a credential bound to another environment", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("runnerCredentials", {
        appId: credentialId, investigationId, environmentId: envA, secret: "hash", expiresAtMs: Date.now() + 60_000, createdAtMs: 1,
      });
    });
    await expect(t.query(internal.agentTools.readFindings, {
      credentialId, investigationId, environmentId: envB, sessionId: attemptId, attemptId, grantId: attemptId, epoch: 1, scope: "investigation", limit: 10,
    })).rejects.toThrow("unauthorized");
  });
});
