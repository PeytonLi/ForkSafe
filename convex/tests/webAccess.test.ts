import { convexTest } from "convex-test";
import type { Auth } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.js";
import { api } from "../_generated/api.js";
import { internalAction } from "../_generated/server.js";
import { mayOperate, mayReview, roleOf } from "../lib/memberRole.js";
import { accessGrantedForUser, newOAuthAccountNeedsInvite, requireOperateIdentity, requireReviewIdentity, requireWriteIdentity, validateInvite } from "../lib/webAccess.js";

const modules = { ...import.meta.glob("../**/*.ts"), "../bridge.ts": async () => ({
  recordReview: internalAction({ args: {}, handler: async () => ({ committed: false }) }),
}) };
const token = "unit-test-service-token";
const id = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const evaluationId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const sha = "a".repeat(64);
const review = { investigationId: id, candidateId, evaluationId, controllerSha256: sha, decision: "rejected" as const };
const capture = { title: "Test", seed: 0, sceneOverrides: {}, requestedEnvironments: 1, idempotencyKey: "seed" };

async function seeded() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("investigations", {
      appId: id, title: "Private title", state: "awaiting_review", cancelStatus: "none", cancelEpoch: 0, version: 1,
      requestedEnvironments: 1, baselineCase: { caseId: "baseline", suite: "original", seed: 0, sceneOverrides: {} }, baselineExperimentId: id,
      budget: { wallTimeMs: 1000, maxExperimentsPerEnv: 1, maxCandidatesPerEnv: 1, maxFinalCandidates: 1 }, idempotencyKey: "seed", createdAtMs: 1, updatedAtMs: 1,
    });
    await ctx.db.insert("candidates", { appId: candidateId, investigationId: id, environmentId: id, status: "evaluated", controllerSha256: sha,
      sourceArtifactId: artifactId, changedFunctions: [], basedOnFindings: [], submittedByAttemptId: id, epoch: 1, spacetimeCommitted: true, submittedAtMs: 1, updatedAtMs: 1 });
    await ctx.db.insert("evaluations", { appId: evaluationId, candidateId, investigationId: id, evaluatorAttemptId: id, epoch: 1, suite: "public", cases: [], allRequiredPassed: false, status: "failed", spacetimeCommitted: true, createdAtMs: 1, updatedAtMs: 1 });
    await ctx.db.insert("replays", { artifactId, experimentId: id, investigationId: id, visibility: "internal", result: { frames: [] }, truncatedFrames: false, createdAtMs: 1 });
  });
  return t;
}

beforeEach(() => {
  vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
  vi.stubEnv("FORKSAFE_DEV_ANONYMOUS_UI", "true");
  vi.stubEnv("CONVEX_CLOUD_URL", "https://hosted.convex.cloud");
  vi.stubEnv("FORKSAFE_PUBLIC_INVESTIGATION_IDS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("invite gate", () => {
  it("fails closed for missing configuration/code and wrong codes, accepts the right code, and leaves sign-in alone", () => {
    expect(() => validateInvite({ flow: "signUp", inviteCode: "right" }, {})).toThrow("Invalid invite code");
    for (const inviteCode of [undefined, "wrong", 123]) expect(() => validateInvite({ flow: "signUp", inviteCode }, { FORKSAFE_INVITE_CODE: "right" })).toThrow("Invalid invite code");
    expect(() => validateInvite({ flow: "signUp", inviteCode: "right" }, { FORKSAFE_INVITE_CODE: "right" })).not.toThrow();
    expect(() => validateInvite({ flow: "signIn" }, {})).not.toThrow();
  });

  it("holds only a brand-new OAuth account for the invite", () => {
    expect(newOAuthAccountNeedsInvite("oauth", null)).toBe(true);
    expect(newOAuthAccountNeedsInvite("oauth", "user")).toBe(false);
    expect(newOAuthAccountNeedsInvite("credentials", null)).toBe(false);
    expect(accessGrantedForUser(null)).toBe(true);
    expect(accessGrantedForUser({})).toBe(true);
    expect(accessGrantedForUser({ accessGranted: false })).toBe(false);
  });
});

describe("google invite gate", () => {
  it("keeps a new Google account closed until the invite is redeemed", async () => {
    const t = await seeded();
    vi.stubEnv("FORKSAFE_INVITE_CODE", "right");
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "person@example.com", accessGranted: false }));
    const caller = t.withIdentity({ subject: `${userId}|session`, tokenIdentifier: `trusted|${userId}` });
    expect(await caller.query(api.auth.viewer, {})).toMatchObject({ email: "person@example.com", accessGranted: false });
    expect((await caller.query(api.investigations.list, {}))[0]?.title).toBe("Restricted investigation");
    await expect(caller.query(api.investigations.workspace, { investigationId: id })).rejects.toThrow("unauthorized");
    await expect(caller.mutation(api.investigations.capture, capture)).rejects.toThrow("unauthorized");
    await expect(caller.action(api.reviews.record, review)).rejects.toThrow("unauthorized");
    await expect(caller.mutation(api.auth.redeemInvite, { inviteCode: "nope" })).resolves.toEqual({ ok: false });
    await expect(caller.action(api.web.ask.ask, { investigationId: id, question: "why did it fail?" })).rejects.toThrow("unauthorized");
    expect((await caller.query(api.investigations.list, {}))[0]?.title).toBe("Restricted investigation");
    await expect(caller.mutation(api.auth.redeemInvite, { inviteCode: "right" })).resolves.toEqual({ ok: true });
    expect(await caller.query(api.auth.viewer, {})).toMatchObject({ accessGranted: true });
    expect((await caller.query(api.investigations.list, {}))[0]?.title).toBe("Private title");
    await expect(caller.mutation(api.investigations.capture, capture)).resolves.toMatchObject({ accepted: false });
  });

  it("stops invite guessing for an hour after eight misses", async () => {
    const t = await seeded();
    vi.stubEnv("FORKSAFE_INVITE_CODE", "right");
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "guess@example.com", accessGranted: false }));
    const caller = t.withIdentity({ subject: `${userId}|session` });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(caller.mutation(api.auth.redeemInvite, { inviteCode: `miss-${attempt}` })).resolves.toEqual({ ok: false });
    }
    await expect(caller.mutation(api.auth.redeemInvite, { inviteCode: "right" })).resolves.toEqual({ ok: false });
    expect(await caller.query(api.auth.viewer, {})).toMatchObject({ accessGranted: false });
  });

  it("leaves an account from before Google sign-in able to read", async () => {
    const t = await seeded();
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "legacy@example.com" }));
    const caller = t.withIdentity({ subject: `${userId}|session` });
    expect((await caller.query(api.investigations.list, {}))[0]?.title).toBe("Private title");
    expect(await caller.query(api.auth.viewer, {})).toMatchObject({ accessGranted: true });
  });
});

describe("write identities", () => {
  const anon = { auth: { getUserIdentity: async () => null } as Auth };
  it("only allows the dev identity on an explicit localhost deployment", async () => {
    for (const host of [undefined, "https://hosted.convex.cloud", "http://localhost.evil.example", "invalid"]) {
      await expect(requireWriteIdentity(anon, undefined, { FORKSAFE_DEV_ANONYMOUS_UI: "true", CONVEX_CLOUD_URL: host })).rejects.toThrow("unauthorized");
    }
    for (const host of ["http://localhost:3210", "http://127.0.0.1:3210"]) {
      await expect(requireWriteIdentity(anon, undefined, { FORKSAFE_DEV_ANONYMOUS_UI: "true", CONVEX_CLOUD_URL: host })).resolves.toBe("local:anonymous-ui");
      await expect(requireWriteIdentity(anon, undefined, { CONVEX_CLOUD_URL: host })).rejects.toThrow("unauthorized");
    }
  });

  it("rejects anonymous capture, cancel, and review on hosted deployments", async () => {
    const t = await seeded();
    await expect(t.mutation(api.investigations.capture, capture)).rejects.toThrow("unauthorized");
    await expect(t.mutation(api.investigations.cancel, { investigationId: id })).rejects.toThrow("unauthorized");
    await expect(t.action(api.reviews.record, review)).rejects.toThrow("unauthorized");
  });

  it.each(["browser", "service"])("accepts %s writes and derives reviewer identity on the server", async (kind) => {
    const t = await seeded();
    const caller = kind === "browser" ? t.withIdentity({ subject: "real-user", tokenIdentifier: "trusted|real-user" }) : t;
    const service = kind === "service" ? { serviceToken: token } : {};
    vi.stubEnv("DAYTONA_MODE", "cloud"); vi.stubEnv("DAYTONA_API_KEY", "test-only");
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["test"]));
      for (const key of ["simulator", "baseline_controller"] as const) await ctx.db.insert("bundles", { key, storageId, sha256: sha, bytes: 4, uploadedAtMs: 1 });
    });
    await expect(caller.mutation(api.investigations.capture, { ...capture, ...service })).resolves.toEqual({ accepted: true, investigationId: id });
    const result = await caller.action(api.reviews.record, { ...review, ...service });
    expect(result.reviewerIdentity).toBe(kind === "browser" ? "convex-auth:real-user" : "service:integration");
    await expect(caller.action(api.reviews.record, { ...review, ...service, reviewerIdentity: "spoofed" } as any)).rejects.toThrow();
    await expect(caller.mutation(api.investigations.cancel, { investigationId: id, ...service })).resolves.toBeDefined();
  });
});

describe("investigation visibility", () => {
  it("redacts private list titles and denies workspace/findings/replay even with the hosted dev flag", async () => {
    const t = await seeded();
    expect(await t.query(api.investigations.list, {})).toEqual([{ id, title: "Restricted investigation", state: "restricted" }]);
    await expect(t.query(api.investigations.workspace, { investigationId: id })).rejects.toThrow("unauthorized");
    await expect(t.query(api.evidence.findings, { investigationId: id })).rejects.toThrow("unauthorized");
    await expect(t.query(api.artifacts.replay, { artifactId })).rejects.toThrow("unauthorized");
    for (const caller of [t.withIdentity({ subject: "reader" }), t]) {
      const args = caller === t ? { serviceToken: token } : {};
      expect((await caller.query(api.investigations.list, args))[0]?.title).toBe("Private title");
      expect(await caller.query(api.investigations.workspace, { investigationId: id, ...args })).toBeDefined();
      expect(await caller.query(api.evidence.findings, { investigationId: id, ...args })).toEqual([]);
      expect(await caller.query(api.artifacts.replay, { artifactId, ...args })).toEqual({ frames: [] });
    }
  });

  it("allows public investigations without a session", async () => {
    const t = await seeded();
    vi.stubEnv("FORKSAFE_PUBLIC_INVESTIGATION_IDS", ` ${id}, `);
    expect((await t.query(api.investigations.list, {}))[0]?.title).toBe("Private title");
    expect(await t.query(api.investigations.workspace, { investigationId: id })).toBeDefined();
    expect(await t.query(api.evidence.findings, { investigationId: id })).toEqual([]);
    expect(await t.query(api.artifacts.replay, { artifactId })).toEqual({ frames: [] });
  });

  it("blocks the candidate lane's private-data bypass on hosted deployments", async () => {
    const t = await seeded();
    await t.run(async (ctx) => {
      await ctx.db.insert("controllerSources", { controllerSha256: sha, artifactId, source: "private controller", bytes: 18, createdAtMs: 1 });
      await ctx.db.insert("experiments", {
        appId: id, investigationId: id, candidateId, environmentId: id, attemptId: id, epoch: 1, purpose: "evaluation", suite: "original",
        simCase: { caseId: "baseline", suite: "original", seed: 0, sceneOverrides: {} }, status: "succeeded", completed: true,
        failureKinds: [], changedFunctions: [], replayArtifactId: artifactId, engineVersion: "test", assetsSha256: sha, controllerSha256: sha,
        spacetimeCommitted: true, startedAtMs: 1,
      });
    });
    await expect(t.query(api.candidates.diff, { candidateId })).rejects.toThrow("unauthorized");
    await expect(t.query(api.candidates.replay, { candidateId })).rejects.toThrow("unauthorized");
    expect(await t.query(api.candidates.diff, { candidateId, serviceToken: token })).toContain("private controller");
    vi.stubEnv("FORKSAFE_DEV_ANONYMOUS_UI", "false");
    const reader = t.withIdentity({ subject: "reader" });
    expect(await reader.query(api.candidates.diff, { candidateId })).toContain("private controller");
    expect(await reader.query(api.candidates.replay, { candidateId })).toEqual({ frames: [] });
  });
});

describe("member seats", () => {
  const anon = { auth: { getUserIdentity: async () => null } as Auth };
  const subject = "user-1|session";

  function identityCtx(user: { memberRole?: string; accessGranted?: boolean } | null) {
    return {
      auth: { getUserIdentity: async () => ({ subject, tokenIdentifier: "trusted|user-1" }) } as Auth,
      db: {
        normalizeId: () => "user-1",
        get: async () => user,
      },
    };
  }

  it("keeps an absent or unknown role as a lead", () => {
    for (const user of [undefined, null, {}, { memberRole: "nope" }]) {
      expect(roleOf(user)).toBe("lead");
      expect(mayOperate(roleOf(user))).toBe(true);
      expect(mayReview(roleOf(user))).toBe(true);
    }
    expect(roleOf({ memberRole: "operator" })).toBe("operator");
    expect(mayOperate("operator")).toBe(true);
    expect(mayReview("operator")).toBe(false);
    expect(mayOperate("reviewer")).toBe(false);
    expect(mayReview("reviewer")).toBe(true);
  });

  it("rejects a reviewer who operates and an operator who reviews, and still lets a missing role do both", async () => {
    await expect(requireOperateIdentity(identityCtx({ memberRole: "reviewer" }))).rejects.toThrow("unauthorized");
    await expect(requireReviewIdentity(identityCtx({ memberRole: "reviewer" }))).resolves.toBe(`convex-auth:${subject}`);
    await expect(requireReviewIdentity(identityCtx({ memberRole: "operator" }))).rejects.toThrow("unauthorized");
    await expect(requireOperateIdentity(identityCtx({ memberRole: "operator" }))).resolves.toBe(`convex-auth:${subject}`);
    await expect(requireOperateIdentity(identityCtx({}))).resolves.toBe(`convex-auth:${subject}`);
    await expect(requireReviewIdentity(identityCtx(null))).resolves.toBe(`convex-auth:${subject}`);
    await expect(requireOperateIdentity(identityCtx({ memberRole: "nope" }))).resolves.toBe(`convex-auth:${subject}`);
    await expect(requireReviewIdentity(identityCtx({ accessGranted: false }))).rejects.toThrow("unauthorized");
  });

  it("lets a service token and the local dev identity operate and review", async () => {
    await expect(requireOperateIdentity(anon, token)).resolves.toBe("service:integration");
    await expect(requireReviewIdentity(anon, token)).resolves.toBe("service:integration");
    const local = { FORKSAFE_DEV_ANONYMOUS_UI: "true", CONVEX_CLOUD_URL: "http://127.0.0.1:3210" };
    await expect(requireOperateIdentity(anon, undefined, local)).resolves.toBe("local:anonymous-ui");
    await expect(requireReviewIdentity(anon, undefined, local)).resolves.toBe("local:anonymous-ui");
  });

  async function account(email: string, memberRole?: "lead" | "operator" | "reviewer") {
    const t = await seeded();
    const userId = await t.run((ctx) => ctx.db.insert("users", { email, ...(memberRole ? { memberRole } : {}) }));
    const caller = t.withIdentity({ subject: `${userId}|session`, tokenIdentifier: `trusted|${userId}` });
    return { t, caller, userId };
  }

  it("lets an account with no seat operate and review", async () => {
    const { caller, userId } = await account("legacy-seat@example.com");
    expect(await caller.query(api.auth.viewer, {})).toMatchObject({ memberRole: "lead", accessGranted: true });
    await expect(caller.mutation(api.investigations.capture, capture)).resolves.toMatchObject({ accepted: false });
    await expect(caller.action(api.reviews.record, review)).resolves.toMatchObject({ reviewerIdentity: `convex-auth:${userId}|session` });
    await expect(caller.action(api.sceneSearch.findFailure, { taskFamily: "divider_pick_place" })).resolves.toMatchObject({ found: false });
    await expect(caller.mutation(api.investigations.cancel, { investigationId: id })).resolves.toBeDefined();
  });

  it("refuses operate actions for a reviewer and review actions for an operator", async () => {
    const reviewer = await account("reviewer@example.com", "reviewer");
    await expect(reviewer.caller.mutation(api.investigations.capture, capture)).rejects.toThrow("unauthorized");
    await expect(reviewer.caller.mutation(api.investigations.cancel, { investigationId: id })).rejects.toThrow("unauthorized");
    await expect(reviewer.caller.action(api.sceneSearch.findFailure, { taskFamily: "divider_pick_place" })).rejects.toThrow("unauthorized");
    await expect(reviewer.caller.action(api.reviews.record, review)).resolves.toMatchObject({ reviewerIdentity: `convex-auth:${reviewer.userId}|session` });

    const operator = await account("operator@example.com", "operator");
    await expect(operator.caller.action(api.reviews.record, review)).rejects.toThrow("unauthorized");
    await expect(operator.caller.mutation(api.investigations.capture, capture)).resolves.toMatchObject({ accepted: false });
    await expect(operator.caller.action(api.sceneSearch.findFailure, { taskFamily: "divider_pick_place" })).resolves.toMatchObject({ found: false });
    await expect(operator.caller.mutation(api.investigations.cancel, { investigationId: id })).resolves.toBeDefined();
  });

  it("lets a service token operate and review without a seat", async () => {
    const t = await seeded();
    await expect(t.mutation(api.investigations.capture, { ...capture, serviceToken: token })).resolves.toMatchObject({ accepted: false });
    await expect(t.action(api.reviews.record, { ...review, serviceToken: token })).resolves.toMatchObject({ reviewerIdentity: "service:integration" });
    await expect(t.action(api.sceneSearch.findFailure, { taskFamily: "divider_pick_place", serviceToken: token })).resolves.toMatchObject({ found: false });
    await expect(t.mutation(api.investigations.cancel, { investigationId: id, serviceToken: token })).resolves.toBeDefined();
  });

  it("lets a lead assign seats and keeps the last lead", async () => {
    const t = await seeded();
    const leadId = await t.run((ctx) => ctx.db.insert("users", { email: "lead@example.com", accessGranted: true }));
    const reviewerId = await t.run((ctx) => ctx.db.insert("users", { email: "reviewer@example.com", memberRole: "reviewer", accessGranted: true }));
    const operatorId = await t.run((ctx) => ctx.db.insert("users", { email: "operator@example.com", memberRole: "operator", accessGranted: true }));
    const pendingId = await t.run((ctx) => ctx.db.insert("users", { email: "pending@example.com", accessGranted: false }));
    const lead = t.withIdentity({ subject: `${leadId}|session` });
    const reviewer = t.withIdentity({ subject: `${reviewerId}|session` });
    const operator = t.withIdentity({ subject: `${operatorId}|session` });
    const pending = t.withIdentity({ subject: `${pendingId}|session` });
    await expect(t.mutation(api.auth.setMemberRole, { role: "lead" })).rejects.toThrow("unauthorized");
    await expect(pending.mutation(api.auth.setMemberRole, { role: "lead" })).rejects.toThrow("unauthorized");
    await expect(reviewer.mutation(api.auth.setMemberRole, { role: "lead" })).rejects.toThrow("unauthorized");
    await expect(operator.mutation(api.auth.setMemberRole, { role: "lead", email: "reviewer@example.com" })).rejects.toThrow("unauthorized");
    await expect(lead.mutation(api.auth.setMemberRole, { role: "reviewer" })).rejects.toThrow(/Pick whose seat/i);
    await expect(lead.mutation(api.auth.setMemberRole, { role: "operator", email: "lead@example.com" })).rejects.toThrow(/own seat/i);
    await lead.mutation(api.auth.setMemberRole, { role: "reviewer", email: "  Operator@Example.com " });
    expect(await operator.query(api.auth.viewer, {})).toMatchObject({ memberRole: "reviewer", accessGranted: true });
    await expect(lead.mutation(api.auth.setMemberRole, { role: "operator", email: "missing@example.com" })).rejects.toThrow("No account with that email");
    await expect(lead.mutation(api.auth.setMemberRole, { role: "operator", email: "lead@example.com" })).rejects.toThrow(/own seat/i);
    expect(await lead.query(api.auth.viewer, {})).toMatchObject({ memberRole: "lead" });
    await lead.mutation(api.auth.setMemberRole, { role: "lead", email: "operator@example.com" });
    expect(await operator.query(api.auth.viewer, {})).toMatchObject({ memberRole: "lead" });
    await expect(lead.mutation(api.auth.setMemberRole, { role: "reviewer", email: "lead@example.com" })).rejects.toThrow(/own seat/i);
  });
});
