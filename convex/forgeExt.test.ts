import { convexTest } from "convex-test";
import type { FunctionReference, HttpRouter } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateEvaluation, ControllerCandidate } from "@forksafe/contracts";
import { FORGE_BACKEND_PATHS, PanelData as OldPanelData, ReviewContext as OldReviewContext } from "../packages/integrations/atlassian/src/index.js";
import { internal } from "./_generated/api.js";
import { registerForgeRoutes, suiteSummaries, webLinks } from "./forge.js";
import { FORGE_FEATURE_PATHS, MoreInvestigationRequest, MoreInvestigationResponse, PanelData, ReviewContext, SuiteSummary } from "./forgeProtocolExt.js";
import type { SpacetimeClient } from "./dispatchers/spacetime.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const id = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const evaluationId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const sha = "a".repeat(64);
const more = { investigationId: id, issueKey: "FS-42", projectKey: "FS", requestedBy: "atlassian:reviewer-1", note: "Try safer motion", extraEnvironments: 2, idempotencyKey: artifactId };
const candidate = ControllerCandidate.parse({ id: candidateId, investigationId: id, environmentId: id, status: "evaluated", controllerSha256: sha, sourceArtifactId: artifactId, changedFunctions: [], submittedByAttemptId: id, submittedAtMs: 1 });
const evaluation = CandidateEvaluation.parse({ id: evaluationId, candidateId, investigationId: id, evaluatorAttemptId: id, suite: "public", cases: [{ caseId: "public-failure", status: "failed" }], status: "failed", allRequiredPassed: false, createdAtMs: 1 });
const withheld = CandidateEvaluation.parse({ ...evaluation, id: artifactId, suite: "withheld", cases: [{ caseId: "private-secret-case", status: "failed" }], createdAtMs: 2 });
const spacetime = {
  listCandidates: async () => [candidate], listEvaluations: async () => [evaluation, withheld], listReviews: async () => [], findingsCount: async () => 30,
  getCandidate: async () => candidate, getEvaluation: async () => evaluation,
} as unknown as SpacetimeClient;

beforeEach(() => {
  vi.stubEnv("FORGE_ALLOWED_INSTALLATION_IDS", "install-good");
  vi.stubEnv("ATLASSIAN_PROJECT_KEY", "FS");
  vi.stubEnv("INTEGRATION_SHARED_SECRET", "unit-secret");
  vi.stubEnv("FORKSAFE_WEB_URL", "https://giant-jellyfish-684.convex.site");
  vi.stubEnv("FORKSAFE_CONFLUENCE_REQUIREMENTS_PAGE_ID", "");
});
afterEach(() => vi.unstubAllEnvs());

function handlers() {
  const routes = new Map<string, (ctx: never, req: Request) => Promise<Response>>();
  registerForgeRoutes({ route: (route: { path: string; handler: (ctx: never, req: Request) => Promise<Response> }) => routes.set(route.path, route.handler) } as unknown as HttpRouter, {
    spacetime: () => spacetime,
    verifyToken: async (token) => {
      if (!["valid", "unknown", "no-principal"].includes(token)) throw new Error("bad token");
      return { appId: "app", installationId: token === "unknown" ? "install-unknown" : "install-good", environmentType: "DEVELOPMENT", projectKey: "FS", issueKey: "FS-42", ...(token === "no-principal" ? {} : { principal: "reviewer-1" }) };
    },
  });
  return async (path: string, body: unknown, ctx: unknown = {}, token = "valid") => routes.get(path)!(ctx as never, new Request(`https://site.invalid${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }));
}

async function seeded() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("investigations", {
      appId: id, title: "Original", state: "awaiting_review", cancelStatus: "none", cancelEpoch: 0, version: 1, requestedEnvironments: 3,
      baselineCase: { caseId: "baseline", suite: "original", seed: 0, sceneOverrides: {} }, baselineExperimentId: id, jiraIssueKey: "FS-42",
      budget: { wallTimeMs: 1000, maxExperimentsPerEnv: 1, maxCandidatesPerEnv: 1, maxFinalCandidates: 1 }, idempotencyKey: "parent-key", createdAtMs: 1, updatedAtMs: 1,
    });
    for (let n = 29; n >= 0; n--) {
      await ctx.db.insert("findings", { appId: crypto.randomUUID(), investigationId: id, environmentId: id, attemptId: id, epoch: 1, kind: "behavioral_note", claim: "observation", summary: `Finding ${n}`,
        evidence: Array.from({ length: n === 29 ? 12 : 1 }, () => ({ kind: "replay_segment" as const, artifactId, experimentId: id, locator: { frame: n } })), spacetimeCommitted: true, createdAtMs: n });
    }
  });
  const ctx = {
    runQuery: (ref: FunctionReference<"query">, args: any) => t.query(ref, args),
    runMutation: (ref: FunctionReference<"mutation">, args: any) => t.mutation(ref, args),
  };
  return { t, ctx };
}

describe("Forge #18 protocol extensions", () => {
  it("returns JSON investigation_not_found on every Forge route", async () => {
    const call = handlers();
    const ctx = { runQuery: async () => null, runMutation: async () => ({ investigationId: id }) };
    const bodies = [
      [FORGE_BACKEND_PATHS.panel, { issueKey: "FS-42", issueId: "42", projectKey: "FS" }],
      [FORGE_BACKEND_PATHS.start, { issueKey: "FS-42", issueId: "42", projectKey: "FS", title: "New" }],
      [FORGE_BACKEND_PATHS.reviewContext, { investigationId: id, candidateId, evaluationId }],
      [FORGE_BACKEND_PATHS.review, { review: { id: artifactId, investigationId: id, candidateId, evaluationId, controllerSha256: sha, decision: "rejected", reviewerIdentity: "atlassian:reviewer-1", createdAtMs: 1 } }],
      [FORGE_FEATURE_PATHS.requests, more],
    ] as const;
    for (const [path, body] of bodies) {
      const response = await call(path, body, ctx);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ error: "investigation_not_found" });
    }
  });

  it("emits compatible panel suites, capped newest findings/citations and HTTPS hash links", async () => {
    const { ctx } = await seeded();
    const response = await handlers()(FORGE_BACKEND_PATHS.panel, { issueKey: "FS-42", issueId: "42", projectKey: "FS" }, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    PanelData.parse(body);
    OldPanelData.parse(body);
    expect(body.findings).toHaveLength(25);
    expect(body.findings[0].summary).toBe("Finding 29");
    expect(body.findings.at(-1).summary).toBe("Finding 5");
    expect(body.findings[0].citations).toHaveLength(10);
    expect(body.findings[0].citations[0]).toEqual({ kind: "replay_segment", artifactId, experimentId: id });
    expect(body.candidates[0].suites).toEqual([
      expect.objectContaining({ suite: "public", failedCases: 1, passedCases: 0, totalCases: 1, failedCaseIds: ["public-failure"] }),
      expect.objectContaining({ suite: "withheld", failedCases: 1, totalCases: 1 }),
    ]);
    expect(body.candidates[0].suites[1]).not.toHaveProperty("failedCaseIds");
    expect(JSON.stringify(body)).not.toContain("private-secret-case");
    expect(body.links.webAppUrl).toBe(`https://giant-jellyfish-684.convex.site/#/investigations/${id}/capture`);
    expect(body.links).not.toHaveProperty("evidencePackUrl");
  });

  it("selects latest suite results, counts cases and never exposes withheld failed IDs", () => {
    expect(suiteSummaries(id, [])).toEqual([]);
    const latest = { ...evaluation, createdAtMs: 3, cases: [{ caseId: "passed", status: "passed" as const, failureKinds: [] }], allRequiredPassed: true, status: "passed" as const };
    const summaries = suiteSummaries(candidateId, [evaluation, withheld, latest]);
    summaries.forEach((s) => SuiteSummary.parse(s));
    expect(summaries[0]).toMatchObject({ passedCases: 1, failedCases: 0, totalCases: 1, failedCaseIds: [] });
    expect(summaries[1]).not.toHaveProperty("failedCaseIds");
    for (const url of ["", "http://web.invalid", "https://name:password@web.invalid", "bad-url"]) {
      vi.stubEnv("FORKSAFE_WEB_URL", url);
      expect(webLinks(id)).toEqual({});
    }
  });

  it("issues storage links only for marked, stored, non-withheld and non-revoked evidence reports", async () => {
    const { t, ctx } = await seeded();
    expect(await t.query(internal.forgeData.evidence, { investigationId: crypto.randomUUID() })).toEqual({ findings: [] });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["Evidence pack"])));
    const report = await t.run((ctx) => ctx.db.insert("artifacts", { appId: artifactId, kind: "report", sha256: sha, bytes: 13, storage: "convex", storageKey: String(storageId), storageId, investigationId: id, visibility: "internal", createdAtMs: 1 }));
    const getContext = async () => {
      const response = await handlers()(FORGE_BACKEND_PATHS.reviewContext, { investigationId: id, candidateId, evaluationId }, ctx);
      expect(response.status).toBe(200);
      const body = await response.json();
      ReviewContext.parse(body);
      OldReviewContext.parse(body);
      return body;
    };
    expect(await getContext()).not.toHaveProperty("evidencePackUrl");
    await t.run((ctx) => ctx.db.patch(report, { evidencePack: true }));
    const body = await getContext();
    expect(body.evidencePackUrl).toMatch(/^https:\/\//);
    const panel = await handlers()(FORGE_BACKEND_PATHS.panel, { issueKey: "FS-42", issueId: "42", projectKey: "FS" }, ctx);
    expect(PanelData.parse(await panel.json()).links.evidencePackUrl).toBe(body.evidencePackUrl);
    await t.run((ctx) => ctx.db.patch(report, { visibility: "withheld" }));
    expect(await getContext()).not.toHaveProperty("evidencePackUrl");
    await t.run((ctx) => ctx.db.patch(report, { visibility: "internal", revokedAtMs: 0 }));
    expect(await getContext()).not.toHaveProperty("evidencePackUrl");
    await t.run((ctx) => ctx.db.patch(report, { revokedAtMs: undefined, storageId: undefined, storage: "local_fs" }));
    expect(await getContext()).not.toHaveProperty("evidencePackUrl");
  });

  it("accepts an evidence-pack marker only on stored report artifacts", async () => {
    const { t } = await seeded();
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["Pack"])));
    const args = { investigationId: id, sha256: sha, bytes: 4, visibility: "internal" as const, storageId, evidencePack: true };
    await expect(t.mutation(internal.artifacts.insertCloudArtifact, { ...args, kind: "replay" })).rejects.toThrow("evidence_pack_must_be_report");
    const result = await t.mutation(internal.artifacts.insertCloudArtifact, { ...args, kind: "report" });
    expect(result.duplicate).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("artifacts").first())).toMatchObject({ kind: "report", evidencePack: true });
    expect(await t.query(internal.forgeData.evidence, { investigationId: id })).toHaveProperty("evidencePackUrl");
  });
});

describe("Forge follow-up requests", () => {
  it("fails closed with 401/403/503, rejects spoofing and mismatched parent issues", async () => {
    const call = handlers();
    expect((await call(FORGE_FEATURE_PATHS.requests, more, {}, "bogus")).status).toBe(401);
    expect((await call(FORGE_FEATURE_PATHS.requests, more, {}, "no-principal")).status).toBe(401);
    expect((await call(FORGE_FEATURE_PATHS.requests, more, {}, "unknown")).status).toBe(403);
    expect((await call(FORGE_FEATURE_PATHS.requests, { ...more, requestedBy: "atlassian:spoof" })).status).toBe(403);
    vi.stubEnv("FORGE_ALLOWED_INSTALLATION_IDS", "");
    expect((await call(FORGE_FEATURE_PATHS.requests, more)).status).toBe(503);
    vi.stubEnv("FORGE_ALLOWED_INSTALLATION_IDS", "install-good");
    expect((await call(FORGE_FEATURE_PATHS.requests, more, { runQuery: async () => ({ investigation: { id, jiraIssueKey: "FS-99" } }) })).status).toBe(403);
    expect((await call(FORGE_FEATURE_PATHS.requests, more, { runQuery: async () => { throw new Error("down"); } })).status).toBe(503);
  });

  it("validates 1–3 environment bounds, strict payload and note length", async () => {
    const call = handlers();
    for (const extraEnvironments of [0, -1, 4, 1.5, "2"]) {
      expect((await call(FORGE_FEATURE_PATHS.requests, { ...more, extraEnvironments })).status).toBe(400);
    }
    for (const note of ["", " ", "x".repeat(501)]) expect((await call(FORGE_FEATURE_PATHS.requests, { ...more, note })).status).toBe(400);
    expect((await call(FORGE_FEATURE_PATHS.requests, { ...more, injected: true })).status).toBe(400);
    for (const extraEnvironments of [undefined, 1, 3]) expect(MoreInvestigationRequest.safeParse({ ...more, extraEnvironments }).success).toBe(true);
  });

  it("atomically admits a linked follow-up, replays stored results and rejects conflicts without starting work", async () => {
    const { t, ctx } = await seeded();
    const call = handlers();
    const response = await call(FORGE_FEATURE_PATHS.requests, more, ctx);
    expect(response.status).toBe(200);
    const result = MoreInvestigationResponse.parse(await response.json());
    expect(result).toMatchObject({ accepted: true, state: "admitted" });
    const replay = await call(FORGE_FEATURE_PATHS.requests, more, ctx);
    expect(await replay.json()).toEqual(result);
    const concurrent = await Promise.all([call(FORGE_FEATURE_PATHS.requests, more, ctx), call(FORGE_FEATURE_PATHS.requests, more, ctx)]);
    for (const response of concurrent) expect(await response.json()).toEqual(result);
    const conflict = await call(FORGE_FEATURE_PATHS.requests, { ...more, note: "Changed" }, ctx);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "request_conflict" });
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("forgeRequests").collect();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ parentInvestigationId: id, requestedBy: "atlassian:reviewer-1", extraEnvironments: 2, result });
      const investigations = await ctx.db.query("investigations").collect();
      expect(investigations).toHaveLength(2);
      expect(investigations.find((row) => row.parentInvestigationId === id)).toMatchObject({ state: "admitted", requestedEnvironments: 2, baselineExperimentId: id, jiraIssueKey: "FS-42" });
      for (const table of ["jobs", "environments", "reservations"] as const) expect(await ctx.db.query(table).collect()).toEqual([]);
      expect(await ctx.db.system.query("_scheduled_functions").collect()).toEqual([]);
    });
  });

  it("defaults an omitted count to one and validates identity, missing parents and payload changes in the mutation", async () => {
    const { t } = await seeded();
    const { extraEnvironments: _, ...request } = more;
    const args = { request, installationId: "install-good", requestedBy: request.requestedBy };
    await t.mutation(internal.investigations.requestMoreFromForge, args);
    expect(await t.run((ctx) => ctx.db.query("forgeRequests").first())).toMatchObject({ extraEnvironments: 1 });
    expect(await t.mutation(internal.investigations.requestMoreFromForge, { ...args, installationId: "another-install" })).toEqual({ error: "request_conflict" });
    expect(await t.mutation(internal.investigations.requestMoreFromForge, { ...args, requestedBy: "atlassian:spoof" })).toEqual({ error: "forbidden" });
    expect(await t.mutation(internal.investigations.requestMoreFromForge, { ...args, request: { ...request, investigationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } })).toEqual({ error: "investigation_not_found" });
    expect(await t.mutation(internal.investigations.requestMoreFromForge, { ...args, request: { ...request, issueKey: "FS-99", idempotencyKey: crypto.randomUUID() } })).toEqual({ error: "forbidden" });
    await expect(t.mutation(internal.investigations.requestMoreFromForge, { ...args, request: { ...request, extraEnvironments: 4 } })).rejects.toThrow();
  });
});
