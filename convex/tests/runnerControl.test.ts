import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.js";
import { api, internal } from "../_generated/api.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> }).glob("../**/*.ts");
const token = "convex-test-service-token";

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

async function startedInvestigation(t: any, environments = 1) {
  const created = await t.mutation(api.investigations.create, { title: "pipeline", requestedEnvironments: environments, idempotencyKey: crypto.randomUUID(), serviceToken: token });
  await t.mutation(api.investigations.start, { investigationId: created.investigationId, expectedVersion: 1, serviceToken: token });
  const envs = await t.run(async (ctx: any) => await ctx.db.query("environments").collect());
  const env = envs[0]!;
  await t.run(async (ctx: any) => { for (const row of envs) await ctx.db.patch(row._id, { state: "active" }); });
  const credential = await t.mutation(internal.runnerControl.issueCredential, { investigationId: created.investigationId, environmentId: env.appId });
  return { investigationId: created.investigationId, environmentId: env.appId, credential, envs };
}

async function claimWithGrant(t: any, credentialId: string, investigationId: string, environmentId: string) {
  const claimed = await t.mutation(internal.runnerControl.claim, { credentialId, workerId: "w1" });
  expect(claimed).not.toBeNull();
  const lease = claimed!.claimed;
  const grant = await t.mutation(internal.grants.create, { jobId: lease.jobId, attemptId: lease.attemptId, epoch: lease.epoch, investigationId, environmentId, purpose: "runner" });
  await t.mutation(internal.grants.markInstalled, { grantId: grant.grantId, committed: true, mode: "fixture" });
  await t.mutation(internal.runnerControl.markGrantInstalled, { credentialId, attemptId: lease.attemptId, epoch: lease.epoch, grantId: grant.grantId, bridgeMode: "fixture" });
  return { lease, grantId: grant.grantId };
}

const session = (id: string) => ({ id, state: "closed" as const, mode: "fixture" as const, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usageKnown: true }, createdAtMs: 1 });

describe("runner control plane", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] }); vi.stubEnv("INTEGRATION_SHARED_SECRET", token); vi.stubEnv("SPACETIMEDB_MODE", "fixture"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("claims only jobs for the credential's environment and rejects revoked credentials", async () => {
    const t = createTest();
    const { investigationId, credential, envs } = await startedInvestigation(t, 2);
    const other = await t.mutation(internal.runnerControl.issueCredential, { investigationId, environmentId: envs[1]!.appId });
    const first = await t.mutation(internal.runnerControl.claim, { credentialId: credential.credentialId, workerId: "w1" });
    expect(first!.job.environmentId).toBe(envs[0]!.appId);
    expect(await t.mutation(internal.runnerControl.claim, { credentialId: credential.credentialId, workerId: "w1" })).toBeNull();
    const second = await t.mutation(internal.runnerControl.claim, { credentialId: other.credentialId, workerId: "w2" });
    expect(second!.job.environmentId).toBe(envs[1]!.appId);
    await t.mutation(internal.runnerControl.revokeCredentials, { investigationId, reason: "test" });
    await expect(t.mutation(internal.runnerControl.claim, { credentialId: credential.credentialId, workerId: "w1" })).rejects.toThrow(/unauthorized/);
  });

  it("walks the handoff stages and completes with sessions recorded", async () => {
    const t = createTest();
    const { investigationId, environmentId, credential } = await startedInvestigation(t);
    const { lease, grantId } = await claimWithGrant(t, credential.credentialId, investigationId, environmentId);
    await t.mutation(internal.runnerControl.recordStage, { credentialId: credential.credentialId, attemptId: lease.attemptId, epoch: lease.epoch, stage: "work_started" });
    const beat = await t.mutation(internal.runnerControl.heartbeat, { credentialId: credential.credentialId, attemptId: lease.attemptId, grantId, epoch: lease.epoch });
    expect(beat.ok).toBe(true);
    const sid = crypto.randomUUID();
    const done = await t.mutation(internal.runnerControl.complete, { credentialId: credential.credentialId, operationId: crypto.randomUUID(), attemptId: lease.attemptId, grantId, epoch: lease.epoch, outcome: "succeeded", result: {}, sessions: [session(sid)], finishedAtMs: Date.now() });
    expect(done).toMatchObject({ accepted: true, jobState: "succeeded" });
    const stages = await t.run(async (ctx: any) => (await ctx.db.query("handoffs").collect()).filter((row: any) => !row.stale).map((row: any) => row.stage));
    expect(stages).toEqual(["admission_reserved", "grant_installed", "work_started", "artifacts_persisted", "evidence_committed", "completion_acknowledged"]);
    const sessions = await t.run(async (ctx: any) => await ctx.db.query("sessions").collect());
    expect(sessions.map((row: any) => row.appId)).toEqual([sid]);
    const grant = await t.run(async (ctx: any) => (await ctx.db.query("grants").collect())[0]);
    expect(grant.revokedAtMs).toBeDefined();
  });

  it("rejects stale epochs after lease expiry and lets the retry claim proceed once the grant is revoked", async () => {
    const t = createTest();
    const { investigationId, environmentId, credential } = await startedInvestigation(t);
    const { lease, grantId } = await claimWithGrant(t, credential.credentialId, investigationId, environmentId);
    await t.mutation(internal.runnerControl.recordStage, { credentialId: credential.credentialId, attemptId: lease.attemptId, epoch: lease.epoch, stage: "work_started" });
    await t.run(async (ctx: any) => {
      const attempt = (await ctx.db.query("attempts").collect())[0];
      await ctx.db.patch(attempt._id, { leasedUntilMs: Date.now() - 60_000 });
      const job = (await ctx.db.query("jobs").collect())[0];
      await ctx.db.patch(job._id, { leaseExpiresAtMs: Date.now() - 60_000 });
    });
    await t.mutation(internal.reconcile.tick, {});
    const stale = await t.mutation(internal.runnerControl.heartbeat, { credentialId: credential.credentialId, attemptId: lease.attemptId, grantId, epoch: lease.epoch });
    expect(stale.ok).toBe(false);
    const staleComplete = await t.mutation(internal.runnerControl.complete, { credentialId: credential.credentialId, operationId: crypto.randomUUID(), attemptId: lease.attemptId, grantId, epoch: lease.epoch, outcome: "succeeded", result: {}, sessions: [], finishedAtMs: Date.now() });
    expect(staleComplete.accepted).toBe(false);
    await expect(t.query(internal.runnerControl.authorizeTool, { credentialId: credential.credentialId, attemptId: lease.attemptId, grantId, epoch: lease.epoch, investigationId, environmentId })).rejects.toThrow();
    await t.mutation(internal.grants.markRevoked, { grantId, spacetimeRevoked: true, reason: "lease_expired" });
    const retry = await t.mutation(internal.runnerControl.claim, { credentialId: credential.credentialId, workerId: "w1" });
    expect(retry!.claimed.epoch).toBe(lease.epoch + 1);
  });

  it("cancellation mid-experiment revokes credentials and fences tools", async () => {
    const t = createTest();
    const { investigationId, environmentId, credential } = await startedInvestigation(t);
    const { lease, grantId } = await claimWithGrant(t, credential.credentialId, investigationId, environmentId);
    const ctxArgs = { credentialId: credential.credentialId, attemptId: lease.attemptId, grantId, epoch: lease.epoch, investigationId, environmentId };
    await expect(t.query(internal.runnerControl.authorizeTool, ctxArgs)).resolves.toBeTruthy();
    await t.mutation(api.investigations.cancel, { investigationId, serviceToken: token });
    await expect(t.query(internal.runnerControl.authorizeTool, ctxArgs)).rejects.toThrow(/cancel|fenced|unauthorized|grant_revoked/);
    const beat = await t.mutation(internal.runnerControl.heartbeat, { credentialId: credential.credentialId, attemptId: lease.attemptId, grantId, epoch: lease.epoch });
    expect(beat.ok).toBe(false);
  });

  it("enforces experiment and candidate budgets per environment", async () => {
    const t = createTest();
    const { investigationId, environmentId, credential } = await startedInvestigation(t);
    const { lease, grantId } = await claimWithGrant(t, credential.credentialId, investigationId, environmentId);
    await t.run(async (ctx: any) => {
      const env = (await ctx.db.query("environments").collect())[0];
      await ctx.db.patch(env._id, { experimentsUsed: env.budgets.maxExperiments, candidatesUsed: env.budgets.maxCandidates });
    });
    const simCase = { caseId: "original-divider-collision", suite: "public" as const, seed: 1, sceneOverrides: {} };
    await expect(t.mutation(internal.evidence.reserveExperiment, { experimentId: crypto.randomUUID(), investigationId, environmentId, attemptId: lease.attemptId, epoch: lease.epoch, grantId, purpose: "development", simCase, controllerSha256: "a".repeat(64), changedFunctions: [] })).rejects.toThrow(/experiment_budget_exhausted/);
    await expect(t.mutation(internal.evidence.reserveExperiment, { experimentId: crypto.randomUUID(), investigationId, environmentId, attemptId: lease.attemptId, epoch: lease.epoch, grantId, purpose: "development", simCase: { ...simCase, suite: "withheld" }, controllerSha256: "a".repeat(64), changedFunctions: [] })).rejects.toThrow(/case_not_public|experiment_budget_exhausted/);
    await expect(t.mutation(internal.evidence.insertCandidate, { candidateId: crypto.randomUUID(), investigationId, environmentId, revisionId: crypto.randomUUID(), attemptId: lease.attemptId, epoch: lease.epoch, grantId, basedOnFindings: [] })).rejects.toThrow(/candidate_budget_exhausted/);
  });

  it("revisions require the expected head and candidates need a revision from the same environment", async () => {
    const t = createTest();
    const { investigationId, environmentId, credential, envs } = await startedInvestigation(t, 2);
    const { lease, grantId } = await claimWithGrant(t, credential.credentialId, investigationId, environmentId);
    const base = { investigationId, environmentId, attemptId: lease.attemptId, epoch: lease.epoch, grantId, sourceArtifactId: crypto.randomUUID(), changedFunctions: ["plan"] };
    const r1 = crypto.randomUUID();
    await t.mutation(internal.evidence.commitRevision, { ...base, revisionId: r1, controllerSha256: "1".repeat(64), source: "def plan(scene):\n    return []\n" });
    await expect(t.mutation(internal.evidence.commitRevision, { ...base, revisionId: crypto.randomUUID(), controllerSha256: "2".repeat(64), source: "x" })).rejects.toThrow(/revision_conflict/);
    const r2 = crypto.randomUUID();
    const second = await t.mutation(internal.evidence.commitRevision, { ...base, revisionId: r2, controllerSha256: "2".repeat(64), source: "y", expectedHeadRevisionId: r1 });
    expect(second.seq).toBe(2);
    await expect(t.mutation(internal.evidence.insertCandidate, { candidateId: crypto.randomUUID(), investigationId, environmentId: envs[1]!.appId, revisionId: r2, attemptId: lease.attemptId, epoch: lease.epoch, basedOnFindings: [] })).rejects.toThrow(/revision_mismatch/);
    const ok = await t.mutation(internal.evidence.insertCandidate, { candidateId: crypto.randomUUID(), investigationId, environmentId, revisionId: r2, attemptId: lease.attemptId, epoch: lease.epoch, basedOnFindings: [] });
    expect(ok.candidate.controllerSha256).toBe("2".repeat(64));
    await expect(t.mutation(internal.evidence.insertCandidate, { candidateId: crypto.randomUUID(), investigationId, environmentId, revisionId: r2, attemptId: lease.attemptId, epoch: lease.epoch, basedOnFindings: [] })).rejects.toThrow(/candidate_duplicate_sha/);
  });

  it("moves to evaluating once all environment jobs settle with a candidate, else fails closed", async () => {
    const t = createTest();
    const { investigationId, environmentId, credential } = await startedInvestigation(t);
    const { lease, grantId } = await claimWithGrant(t, credential.credentialId, investigationId, environmentId);
    await t.mutation(internal.runnerControl.recordStage, { credentialId: credential.credentialId, attemptId: lease.attemptId, epoch: lease.epoch, stage: "work_started" });
    await t.mutation(internal.runnerControl.complete, { credentialId: credential.credentialId, operationId: crypto.randomUUID(), attemptId: lease.attemptId, grantId, epoch: lease.epoch, outcome: "succeeded", result: {}, sessions: [], finishedAtMs: Date.now() });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const investigation = await t.run(async (ctx: any) => (await ctx.db.query("investigations").collect())[0]);
    expect(investigation.state).toBe("failed");
    expect(investigation.lastError).toBe("no_candidates_submitted");
  });
});
