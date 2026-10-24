import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { getFunctionName } from "convex/server";
import { CONVEX_FUNCTIONS, CONVEX_LEARNING_FUNCTIONS, CONVEX_RESPONSE_SCHEMAS as schemas } from "../../apps/web/src/services/convexClient.js";
import { api } from "../_generated/api.js";
import schema from "../schema.js";
import * as investigations from "../investigations.js";
import * as evidence from "../evidence.js";
import * as artifacts from "../artifacts.js";
import * as candidates from "../candidates.js";
import * as reviews from "../reviews.js";
import * as sceneSearch from "../sceneSearch.js";
import * as learning from "../learning.js";

const modules = import.meta.glob("../**/*.ts");
const id = "11111111-1111-4111-8111-111111111111";
const experimentId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const environmentId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const simCase = { caseId: "baseline", suite: "original" as const, seed: 0, sceneOverrides: {} };
const replay = { experimentId, completed: false, failureKinds: ["forbidden_contact"], frames: [], engineVersion: "test", assetsSha256: "a".repeat(64), controllerSha256: "b".repeat(64) };

afterEach(() => vi.unstubAllEnvs());

describe("web Convex contracts", () => {
  it("exposes every expected name as a public function of the expected kind", () => {
    const expected = {
      listInvestigations: api.investigations.list,
      workspace: api.investigations.workspace,
      findings: api.evidence.findings,
      replay: api.artifacts.replay,
      candidateReplay: api.candidates.replay,
      candidateDiff: api.candidates.diff,
      cancel: api.investigations.cancel,
      capture: api.investigations.capture,
      findFailure: api.sceneSearch.findFailure,
      recordReview: api.reviews.record,
    } satisfies Record<keyof typeof CONVEX_FUNCTIONS, FunctionReference<"query" | "mutation" | "action", "public">>;
    const implementations: Record<string, Record<string, unknown>> = { investigations, evidence, artifacts, candidates, reviews, sceneSearch };
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      expect(getFunctionName(expected[key])).toBe(CONVEX_FUNCTIONS[key]);
      const [module, name] = CONVEX_FUNCTIONS[key].split(":") as [string, string];
      const fn = implementations[module]![name] as { isPublic?: boolean; isQuery?: boolean; isMutation?: boolean; isAction?: boolean };
      expect(fn, CONVEX_FUNCTIONS[key]).toBeDefined();
      expect(fn.isPublic).toBe(true);
      const kind = key === "recordReview" || key === "findFailure" ? "isAction" : key === "capture" || key === "cancel" ? "isMutation" : "isQuery";
      expect(fn[kind], CONVEX_FUNCTIONS[key]).toBe(true);
    }
  });

  it("exposes the learning view, retry, and current-controller functions", () => {
    const expected = {
      learning: api.learning.view,
      retry: api.learning.retry,
      currentController: api.learning.currentController,
    } satisfies Record<keyof typeof CONVEX_LEARNING_FUNCTIONS, FunctionReference<"query" | "mutation", "public">>;
    const kinds = { learning: "isQuery", retry: "isMutation", currentController: "isQuery" } as const;
    const functions = { learning: learning.view, retry: learning.retry, currentController: learning.currentController };
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      expect(getFunctionName(expected[key])).toBe(CONVEX_LEARNING_FUNCTIONS[key]);
      const fn = functions[key] as { isPublic?: boolean; isQuery?: boolean; isMutation?: boolean };
      expect(fn.isPublic).toBe(true);
      expect(fn[kinds[key]]).toBe(true);
    }
  });

  it("validates seeded list, workspace, findings, and replay outputs with the web schemas", async () => {
    vi.stubEnv("FORKSAFE_PUBLIC_INVESTIGATION_IDS", id);
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("investigations", {
        appId: id, title: "Contract test", state: "admitted", cancelStatus: "none", cancelEpoch: 0, version: 1,
        requestedEnvironments: 1, baselineCase: simCase, baselineExperimentId: experimentId,
        budget: { wallTimeMs: 1000, maxExperimentsPerEnv: 1, maxCandidatesPerEnv: 1, maxFinalCandidates: 1 },
        idempotencyKey: "contract-test", createdAtMs: 1, updatedAtMs: 1,
      });
      await ctx.db.insert("experiments", {
        appId: experimentId, investigationId: id, attemptId, epoch: 1, purpose: "baseline", suite: "original", simCase,
        status: "physics_failure", failureKinds: replay.failureKinds, completed: false, changedFunctions: [], replayArtifactId: artifactId,
        engineVersion: replay.engineVersion, assetsSha256: replay.assetsSha256, controllerSha256: replay.controllerSha256,
        spacetimeCommitted: true, startedAtMs: 1, finishedAtMs: 2,
      });
      await ctx.db.insert("findings", {
        appId: crypto.randomUUID(), investigationId: id, environmentId, attemptId, epoch: 1,
        kind: "collision_frame", claim: "observation", summary: "Observed collision", evidence: [{ kind: "trace_frame", artifactId, locator: { frame: 0 } }],
        spacetimeCommitted: true, createdAtMs: 2,
      });
      await ctx.db.insert("replays", { artifactId, experimentId, investigationId: id, visibility: "internal", result: replay, truncatedFrames: false, createdAtMs: 2 });
    });
    expect(schemas.listInvestigations.parse(await t.query(api.investigations.list, {}))).toHaveLength(1);
    const workspace = schemas.workspace.parse(await t.query(api.investigations.workspace, { investigationId: id }));
    expect(workspace.experiments[0]?.replayArtifactId).toBe(artifactId);
    expect(schemas.findings.parse(await t.query(api.evidence.findings, { investigationId: id }))).toHaveLength(1);
    expect(schemas.replay.parse(await t.query(api.artifacts.replay, { artifactId }))).toEqual(replay);
  });

  it("validates empty collections and rejects missing workspace/replay records", async () => {
    vi.stubEnv("FORKSAFE_PUBLIC_INVESTIGATION_IDS", id);
    const t = convexTest(schema, modules);
    expect(schemas.listInvestigations.parse(await t.query(api.investigations.list, {}))).toEqual([]);
    expect(schemas.findings.parse(await t.query(api.evidence.findings, { investigationId: id }))).toEqual([]);
    await expect(t.query(api.investigations.workspace, { investigationId: id })).rejects.toThrow(/not found/);
    await expect(t.query(api.artifacts.replay, { artifactId })).rejects.toThrow(/not found/);
  });

  it("denies unauthenticated web writes even when anonymous reads are enabled", async () => {
    vi.stubEnv("FORKSAFE_DEV_ANONYMOUS_UI", "true");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://hosted.convex.cloud");
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.investigations.capture, { title: "", seed: 0, sceneOverrides: {}, requestedEnvironments: 1 })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.investigations.cancel, { investigationId: id })).rejects.toThrow(/unauthorized/);
    await expect(t.action(api.reviews.record, { investigationId: id, candidateId: id, evaluationId: id, controllerSha256: "a".repeat(64), decision: "rejected" })).rejects.toThrow(/unauthorized/);
    expect(await t.run((ctx) => ctx.db.query("investigations").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("reviews").collect())).toEqual([]);
  });
});
