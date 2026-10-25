import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api.js";
import schema from "../schema.js";
import { currentControllerForFamily, retryGate, retryIdempotencyKey, selectPriorHints } from "../learning.js";

const modules = import.meta.glob("../**/*.ts");
const investigationId = "11111111-1111-4111-8111-111111111111";
const baselineExperimentId = "22222222-2222-4222-8222-222222222222";
const environmentId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";
const reviewId = "55555555-5555-4555-8555-555555555555";
const findingId = "66666666-6666-4666-8666-666666666666";
const artifactId = "77777777-7777-4777-8777-777777777777";
const baselineSha = "b".repeat(64);
const approvedSha = "c".repeat(64);
const simCase = { caseId: "seed-1042", suite: "original" as const, seed: 1042, sceneOverrides: { dividerHeight: 0.15 } };
const budget = { wallTimeMs: 60_000, maxExperimentsPerEnv: 1, maxCandidatesPerEnv: 1, maxFinalCandidates: 1 };

async function seedInvestigation(t: ReturnType<typeof convexTest>, state: "awaiting_review" | "completed" | "capturing" = "awaiting_review") {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["baseline"])));
  const simulatorStorageId = await t.run((ctx) => ctx.storage.store(new Blob(["simulator"])));
  await t.run(async (ctx) => {
    await ctx.db.insert("bundles", { key: "baseline_controller", storageId, sha256: baselineSha, bytes: 8, uploadedAtMs: 1 });
    await ctx.db.insert("bundles", { key: "simulator", storageId: simulatorStorageId, sha256: "d".repeat(64), bytes: 9, uploadedAtMs: 1 });
    await ctx.db.insert("investigations", {
      appId: investigationId, title: "Panda clips divider", taskFamily: "divider_pick_place",
      state, cancelStatus: "none", cancelEpoch: 0, version: 1, requestedEnvironments: 1,
      baselineCase: simCase, baselineExperimentId, budget, idempotencyKey: "learning-test",
      createdAtMs: 1, updatedAtMs: 1,
    });
    await ctx.db.insert("experiments", {
      appId: baselineExperimentId, investigationId, attemptId: "88888888-8888-4888-8888-888888888888",
      epoch: 0, purpose: "baseline", suite: "original", simCase, status: "physics_failure",
      failureKinds: ["forbidden_contact"], completed: false, changedFunctions: [], engineVersion: "test",
      assetsSha256: "a".repeat(64), controllerSha256: baselineSha, spacetimeCommitted: false, startedAtMs: 1,
    });
  });
}

function stubCaptureEnvironment() {
  vi.stubEnv("FORKSAFE_DEV_ANONYMOUS_UI", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://localhost:3210");
  vi.stubEnv("DAYTONA_MODE", "cloud");
  vi.stubEnv("DAYTONA_API_KEY", "test-key");
}

afterEach(() => vi.unstubAllEnvs());

describe("learning loop", () => {
  it("promotes only approved reviews and resolves the latest controller", async () => {
    const t = convexTest(schema, modules);
    await seedInvestigation(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("candidates", {
        appId: candidateId, investigationId, environmentId, status: "evaluated", controllerSha256: approvedSha,
        sourceArtifactId: artifactId, changedFunctions: ["plan_transit"], basedOnFindings: [findingId],
        submittedByAttemptId: "88888888-8888-4888-8888-888888888888", epoch: 1,
        spacetimeCommitted: false, submittedAtMs: 2, updatedAtMs: 2,
      });
      await ctx.db.insert("controllerSources", {
        controllerSha256: approvedSha, investigationId, artifactId, source: "controller()", bytes: 12, createdAtMs: 2,
      });
    });
    await t.mutation(internal.reviews.insert, {
      reviewId, investigationId, candidateId, evaluationId: "99999999-9999-4999-8999-999999999999",
      controllerSha256: approvedSha, decision: "rejected", reviewerIdentity: "tester",
      idempotencyKey: "rejected", spacetimeCommitted: false,
    });
    expect(await t.run((ctx) => ctx.db.query("controllerLineage").collect())).toHaveLength(0);
    await t.mutation(internal.reviews.insert, {
      reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", investigationId, candidateId,
      evaluationId: "99999999-9999-4999-8999-999999999999", controllerSha256: approvedSha,
      decision: "approved", reviewerIdentity: "tester", idempotencyKey: "approved", spacetimeCommitted: false,
    });
    const current = await t.run((ctx) => currentControllerForFamily(ctx, "divider_pick_place"));
    expect(current).toMatchObject({ version: 2, controllerSha256: approvedSha, source: "approved" });
    expect(await t.run((ctx) => ctx.db.query("controllerLineage").collect())).toHaveLength(1);
  });

  it("captures with the latest approved controller by default and the baseline when requested", async () => {
    stubCaptureEnvironment();
    const t = convexTest(schema, modules);
    await seedInvestigation(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("controllerLineage", {
        appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", taskFamily: "divider_pick_place", version: 2,
        controllerSha256: approvedSha, parentControllerSha256: baselineSha, investigationId,
        candidateId, evaluationId: "99999999-9999-4999-8999-999999999999",
        reviewId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", approvedBy: "tester",
        spacetimeCommitted: false, createdAtMs: 2,
      });
    });
    for (const [choice, sha, version] of [
      ["approved", approvedSha, 2],
      ["baseline", baselineSha, 1],
    ] as const) {
      const result = await t.mutation(api.investigations.capture, {
        title: `Capture ${choice}`, seed: 1042, sceneOverrides: simCase.sceneOverrides, requestedEnvironments: 1,
        controller: choice, idempotencyKey: `capture-${choice}-123`,
      });
      expect(result.accepted).toBe(true);
      if (!result.accepted) continue;
      const row = await t.run((ctx) => ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", result.investigationId)).unique());
      expect(row).toMatchObject({ controllerSha256: sha, controllerVersion: version, controllerChoice: choice });
    }
  });

  it("selects only same-family findings offered to the environment for cross-run citation", async () => {
    const t = convexTest(schema, modules);
    await seedInvestigation(t, "completed");
    await t.run(async (ctx) => {
      const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await ctx.db.insert("investigations", {
        appId: sourceId, title: "Earlier Panda investigation", taskFamily: "divider_pick_place",
        state: "completed", cancelStatus: "none", cancelEpoch: 0, version: 2, requestedEnvironments: 1,
        baselineCase: simCase, baselineExperimentId, budget, idempotencyKey: "prior-hint-source",
        createdAtMs: 2, updatedAtMs: 2,
      });
      await ctx.db.insert("findings", {
        appId: findingId, investigationId: sourceId, environmentId,
        attemptId: "88888888-8888-4888-8888-888888888888", epoch: 1, kind: "collision_frame",
        claim: "observation", summary: "Lift higher before crossing divider", evidence: [], spacetimeCommitted: false, createdAtMs: 3,
      });
      await ctx.db.insert("candidates", {
        appId: candidateId, investigationId: sourceId, environmentId, status: "evaluated", controllerSha256: approvedSha,
        sourceArtifactId: artifactId, changedFunctions: ["plan_transit"], basedOnFindings: [findingId],
        submittedByAttemptId: "88888888-8888-4888-8888-888888888888", epoch: 1,
        spacetimeCommitted: false, submittedAtMs: 3, updatedAtMs: 3,
      });
      await ctx.db.insert("controllerLineage", {
        appId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", taskFamily: "divider_pick_place", version: 2,
        controllerSha256: approvedSha, parentControllerSha256: baselineSha, investigationId: sourceId,
        candidateId, evaluationId: "99999999-9999-4999-8999-999999999999",
        reviewId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", approvedBy: "tester",
        spacetimeCommitted: false, createdAtMs: 3,
      });
    });
    const unoffered = await t.query(internal.agentTools.checkCitedFindings, { investigationId, environmentId, findingIds: [findingId] });
    expect(unoffered).toMatchObject({ status: "rejected", reason: "finding_not_in_investigation" });
    const offered = await t.run((ctx) => selectPriorHints(ctx, {
      appId: investigationId, taskFamily: "divider_pick_place",
    }));
    expect(offered).toMatchObject([{ findingId, summary: "Lift higher before crossing divider" }]);
    await t.run(async (ctx) => {
      await ctx.db.insert("priorHintOffers", {
        investigationId, environmentId, findingId, sourceInvestigationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        rank: 0, summary: "Lift higher before crossing divider", offeredAtMs: 4,
      });
    });
    const accepted = await t.query(internal.agentTools.checkCitedFindings, { investigationId, environmentId, findingIds: [findingId] });
    expect(accepted).toMatchObject({ status: "ok", findings: [{ crossRun: true }] });
  });

  it("exposes the baseline in learning view, gates retries, and uses a stable retry idempotency key", async () => {
    vi.stubEnv("FORKSAFE_PUBLIC_INVESTIGATION_IDS", investigationId);
    const t = convexTest(schema, modules);
    await seedInvestigation(t);
    const view = await t.query(api.learning.view, { investigationId });
    expect(view).toMatchObject({
      taskFamily: "divider_pick_place",
      lineage: [{ version: 1, controllerSha256: baselineSha }],
      current: { version: 1, controllerSha256: baselineSha },
      thisRun: { version: 1, controllerSha256: baselineSha },
      retry: { available: false, reason: "No fix has been approved for this task yet." },
    });
    expect(retryGate("awaiting_review", { version: 2, controllerSha256: approvedSha }, baselineSha)).toBeNull();
    expect(retryGate("capturing", { version: 2, controllerSha256: approvedSha }, baselineSha)).toMatch(/awaiting review/);
    expect(retryIdempotencyKey(investigationId, approvedSha)).toBe(`retry:${investigationId}:${approvedSha}`);
  });

  it("completes a retry when its capture is recorded", async () => {
    const t = convexTest(schema, modules);
    await seedInvestigation(t, "completed");
    await t.run(async (ctx) => {
      await ctx.db.patch((await ctx.db.query("investigations").first())!._id, {
        retryOfInvestigationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        controllerSha256: approvedSha, controllerVersion: 2,
      });
    });
    await t.mutation(internal.investigations.setCapture, { investigationId, captureStatus: "recorded" });
    expect(await t.run((ctx) => ctx.db.query("investigations").first())).toMatchObject({ state: "completed", captureStatus: "recorded" });
  });

  it("completes the investigation when the recorded baseline did not fail", async () => {
    const t = convexTest(schema, modules);
    await seedInvestigation(t, "capturing");
    await t.mutation(internal.investigations.setCapture, { investigationId, captureStatus: "recorded", promote: false });
    expect(await t.run((ctx) => ctx.db.query("investigations").first())).toMatchObject({ state: "completed", captureStatus: "recorded" });
  });

  it("gates retries and creates one idempotent retry without factory jobs", async () => {
    stubCaptureEnvironment();
    const t = convexTest(schema, modules);
    await seedInvestigation(t);
    const caller = t.withIdentity({ subject: "tester|session" });
    const gated = await caller.mutation(api.learning.retry, { investigationId });
    expect(gated).toMatchObject({ accepted: false, reason: "No fix has been approved for this task yet." });
    await t.run(async (ctx) => {
      await ctx.db.insert("controllerLineage", {
        appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", taskFamily: "divider_pick_place", version: 2,
        controllerSha256: approvedSha, parentControllerSha256: baselineSha, investigationId,
        candidateId, evaluationId: "99999999-9999-4999-8999-999999999999",
        reviewId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", approvedBy: "tester",
        spacetimeCommitted: false, createdAtMs: 2,
      });
    });
    const first = await caller.mutation(api.learning.retry, { investigationId });
    const second = await caller.mutation(api.learning.retry, { investigationId });
    expect(first).toMatchObject({ accepted: true });
    expect(second).toEqual(first);
    if (!first.accepted) return;
    const retry = await t.run((ctx) => ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", first.investigationId)).unique());
    expect(retry).toMatchObject({
      retryOfInvestigationId: investigationId, controllerSha256: approvedSha, controllerVersion: 2,
      controllerChoice: "approved", requestedEnvironments: 1, autoStart: false,
      baselineCase: simCase, state: "capturing",
    });
    expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(0);
  });
});
