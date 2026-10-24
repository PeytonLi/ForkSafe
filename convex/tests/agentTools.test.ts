import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.js";
import { api, internal } from "../_generated/api.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> }).glob("../**/*.ts");
const token = "agent-tools-test-token";
type RunnerToolContext = {
  credentialId: string; investigationId: string; environmentId: string;
  sessionId: string; attemptId: string; grantId: string; epoch: number;
};

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

async function runnerContexts(t: any, count = 1) {
  const created = await t.mutation(api.investigations.create, {
    title: "tools", requestedEnvironments: count, idempotencyKey: crypto.randomUUID(), serviceToken: token,
  });
  await t.mutation(api.investigations.start, { investigationId: created.investigationId, expectedVersion: 1, serviceToken: token });
  const environments = await t.run(async (ctx: any) => {
    const rows = await ctx.db.query("environments").collect();
    for (const row of rows) await ctx.db.patch(row._id, { state: "active" });
    return rows;
  });
  const contexts: RunnerToolContext[] = [];
  for (const environment of environments) {
    const credential = await t.mutation(internal.runnerControl.issueCredential, {
      investigationId: created.investigationId, environmentId: environment.appId,
    });
    const claim = await t.mutation(internal.runnerControl.claim, { credentialId: credential.credentialId, workerId: "test" });
    const lease = claim!.claimed;
    const grant = await t.mutation(internal.grants.create, {
      jobId: lease.jobId, attemptId: lease.attemptId, epoch: lease.epoch,
      investigationId: created.investigationId, environmentId: environment.appId, purpose: "runner",
    });
    await t.mutation(internal.grants.markInstalled, { grantId: grant.grantId, committed: true, mode: "fixture" });
    await t.mutation(internal.runnerControl.markGrantInstalled, {
      credentialId: credential.credentialId, attemptId: lease.attemptId, epoch: lease.epoch,
      grantId: grant.grantId, bridgeMode: "fixture",
    });
    const sessionId = crypto.randomUUID();
    await t.mutation(internal.runnerControl.upsertSession, {
      credentialId: credential.credentialId, attemptId: lease.attemptId, epoch: lease.epoch,
      session: { id: sessionId, state: "streaming", mode: "fixture", tokenUsage: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usageKnown: true,
      }, createdAtMs: Date.now() },
    });
    contexts.push({
      credentialId: credential.credentialId, investigationId: created.investigationId,
      environmentId: environment.appId, sessionId, attemptId: lease.attemptId, grantId: grant.grantId, epoch: lease.epoch,
    });
  }
  return contexts;
}

describe("agent tool persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    vi.stubEnv("SPACETIMEDB_MODE", "fixture");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("returns stored duplicate results and enforces per-tool reservations", async () => {
    const t = convexTest(schema, modules);
    const context = {
      investigationId: crypto.randomUUID(), environmentId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(), epoch: 0, tool: "inspect_failure",
    };
    const callIds = Array.from({ length: 10 }, () => crypto.randomUUID());
    for (const callId of callIds) {
      await expect(t.mutation(internal.agentTools.reserveToolCall, { ...context, callId })).resolves.toMatchObject({ status: "reserved" });
    }
    const stored = { status: "error", reason: "temporary_failure" };
    await t.mutation(internal.agentTools.finishToolCall, { callId: callIds[0]!, result: stored });
    await expect(t.mutation(internal.agentTools.reserveToolCall, { ...context, callId: callIds[0]! }))
      .resolves.toEqual({ status: "duplicate", result: stored });
    await expect(t.mutation(internal.agentTools.reserveToolCall, {
      ...context, callId: callIds[0]!, tool: "read_source",
    })).rejects.toThrow(/call_id_conflict/);
    await expect(t.mutation(internal.agentTools.reserveToolCall, {
      ...context, callId: crypto.randomUUID(),
    })).resolves.toMatchObject({ status: "rejected", result: { reason: "budget_exhausted" } });
  });

  it("requires cross-environment findings to be read first", async () => {
    const t = convexTest(schema, modules);
    const investigationId = crypto.randomUUID();
    const environmentA = crypto.randomUUID();
    const environmentB = crypto.randomUUID();
    const findingId = crypto.randomUUID();
    await t.mutation(internal.evidence.insertFinding, {
      findingId, investigationId, environmentId: environmentA, attemptId: crypto.randomUUID(), epoch: 0,
      kind: "behavioral_note", claim: "inference", summary: "Peer observation",
      evidence: [{ kind: "metric", locator: { metric: "contact_count" } }],
    });
    await expect(t.query(internal.agentTools.checkCitedFindings, {
      investigationId, environmentId: environmentB, findingIds: [findingId],
    })).resolves.toEqual({ status: "rejected", reason: "finding_not_read" });
    await t.mutation(internal.agentTools.recordFindingReads, {
      investigationId, environmentId: environmentB, sessionId: crypto.randomUUID(), findingIds: [findingId],
    });
    await expect(t.query(internal.agentTools.checkCitedFindings, {
      investigationId, environmentId: environmentB, findingIds: [findingId],
    })).resolves.toMatchObject({ status: "ok", findings: [{ appId: findingId }] });
    await expect(t.query(internal.agentTools.checkCitedFindings, {
      investigationId, environmentId: environmentA, findingIds: [findingId],
    })).resolves.toMatchObject({ status: "ok", findings: [{ appId: findingId }] });
  });

  it("rejects withheld and absolute source paths, stale heads, and stale epochs", async () => {
    const t = createTest();
    const context = (await runnerContexts(t))[0]!;
    for (const path of [
      "../evaluation/withheld/manifest.json",
      "/etc/passwd",
      "evaluation/withheld/manifest.json",
      "evaluation/reference_controller/task_controller.py",
    ]) {
      await expect(t.query(internal.agentTools.readSource, { ...context, path }))
        .resolves.toMatchObject({ status: "rejected", reason: "path_not_allowed" });
    }
    await expect(t.action(internal.agentTools.applyPatch, {
      ...context, diff: "", expectedHeadRevisionId: crypto.randomUUID(),
      rationale: "stale head", basedOnFindings: [],
    })).resolves.toEqual({ status: "rejected", reason: "stale_head" });
    await expect(t.query(internal.agentTools.readSource, {
      ...context, epoch: context.epoch + 1, path: "task_controller.py",
    })).rejects.toThrow();
  });

  it("reads a peer finding before candidate submission and mirrors one bridge use", async () => {
    const t = createTest();
    const [sourceContext, targetContext] = await runnerContexts(t, 2);
    const findingId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const candidateSha = "c".repeat(64);
    await t.mutation(internal.evidence.insertFinding, {
      findingId, investigationId: sourceContext!.investigationId, environmentId: sourceContext!.environmentId,
      attemptId: sourceContext!.attemptId, epoch: sourceContext!.epoch, grantId: sourceContext!.grantId,
      kind: "behavioral_note", claim: "inference", summary: "Peer observation",
      evidence: [{ kind: "metric", locator: { metric: "contact_count" } }],
    });
    await t.mutation(internal.evidence.commitRevision, {
      revisionId, investigationId: targetContext!.investigationId, environmentId: targetContext!.environmentId,
      attemptId: targetContext!.attemptId, epoch: targetContext!.epoch, grantId: targetContext!.grantId,
      controllerSha256: candidateSha, sourceArtifactId: crypto.randomUUID(), source: "def plan(scene):\n    return []\n",
      changedFunctions: ["plan"],
    });
    const args = {
      ...targetContext!, revisionId, rationale: "evidence-backed",
      basedOnFindings: [findingId],
    };
    await expect(t.action(internal.agentTools.submitCandidate, args)).resolves.toEqual({
      status: "rejected", reason: "finding_not_read",
    });
    expect(await t.run(async (ctx: any) => await ctx.db.query("candidates").collect())).toHaveLength(0);

    const findings = await t.query(internal.agentTools.readFindings, {
      ...targetContext!, sessionId: args.sessionId, scope: "investigation", limit: 20,
    });
    await t.mutation(internal.agentTools.recordFindingReads, {
      investigationId: targetContext!.investigationId, environmentId: targetContext!.environmentId,
      sessionId: args.sessionId, findingIds: findings.findings.map((row: any) => row.id),
    });
    const requests: { url: string; body: any }[] = [];
    vi.stubEnv("SPACETIMEDB_MODE", "local");
    vi.stubEnv("SPACETIMEDB_URI", "ws://127.0.0.1:3000");
    vi.stubEnv("SPACETIMEDB_DATABASE", "forksafe-test");
    vi.stubEnv("SPACETIMEDB_BRIDGE_TOKEN", "bridge-token");
    vi.stubEnv("FORKSAFE_BRIDGE_SECRET", "bridge-secret");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return { status: 200, text: async () => "" };
    }));
    const submitted = await t.action(internal.agentTools.submitCandidate, args);
    expect(submitted).toMatchObject({ status: "submitted" });
    const candidateId = (submitted as any).candidateId as string;
    const uses = await t.run(async (ctx: any) => await ctx.db.query("findingUses").collect());
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ findingId, candidateId, crossEnvironment: true });
    const findingUseRequest = requests.find((request) => request.url.endsWith("/call/record_finding_use"));
    expect(findingUseRequest?.body).toMatchObject({
      grant: { grant_id: targetContext!.grantId, attempt_id: targetContext!.attemptId, epoch: targetContext!.epoch },
      findingId, candidateId: { some: candidateId },
    });
    await t.mutation(internal.agentTools.mirrorFindingUse, {
      appId: uses[0]!.appId, findingId, findingEnvironmentId: sourceContext!.environmentId,
      usedByEnvironmentId: targetContext!.environmentId, candidateId, spacetimeCommitted: true,
    });
    await t.mutation(internal.evidence.insertFinding, {
      findingId: crypto.randomUUID(), investigationId: targetContext!.investigationId,
      environmentId: targetContext!.environmentId, attemptId: targetContext!.attemptId,
      epoch: targetContext!.epoch, grantId: targetContext!.grantId, kind: "behavioral_note",
      claim: "inference", summary: "Local observation", evidence: [{ kind: "metric", locator: { metric: "contact_count" } }],
    });
    const localRevisionId = crypto.randomUUID();
    await t.mutation(internal.evidence.commitRevision, {
      revisionId: localRevisionId, investigationId: targetContext!.investigationId,
      environmentId: targetContext!.environmentId, attemptId: targetContext!.attemptId,
      epoch: targetContext!.epoch, grantId: targetContext!.grantId, controllerSha256: "d".repeat(64),
      sourceArtifactId: crypto.randomUUID(), source: "def plan(scene):\n    return []\n", changedFunctions: ["plan"],
      expectedHeadRevisionId: revisionId,
    });
    const localFindings = await t.run(async (ctx: any) =>
      (await ctx.db.query("findings").collect()).filter((row: any) => row.environmentId === targetContext!.environmentId));
    await expect(t.action(internal.agentTools.submitCandidate, {
      ...args, revisionId: localRevisionId, basedOnFindings: [localFindings[0]!.appId],
    })).resolves.toMatchObject({ status: "submitted" });
    expect(await t.run(async (ctx: any) => await ctx.db.query("findingUses").collect())).toHaveLength(1);
  });
});
