import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api.js";
import schema from "../schema.js";

const modules = import.meta.glob("../**/*.ts");
const investigationId = "11111111-1111-4111-8111-111111111111";

describe("personal workspaces", () => {
  it("keeps a simulation in the owner's workspace until they invite someone", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run((ctx) => ctx.db.insert("users", { email: "owner@example.com", accessGranted: false }));
    const guestId = await t.run((ctx) => ctx.db.insert("users", { email: "guest@example.com", accessGranted: false }));
    const owner = t.withIdentity({ subject: `${ownerId}|session` });
    const guest = t.withIdentity({ subject: `${guestId}|session` });
    const workspace = await owner.mutation(api.workspaces.ensure, {});
    expect(workspace.name).toBe("owner's workspace");
    await t.run((ctx) => ctx.db.insert("investigations", {
      appId: investigationId, title: "Owner only", state: "capturing", cancelStatus: "none", cancelEpoch: 0, version: 1,
      requestedEnvironments: 1, baselineCase: { caseId: "baseline", suite: "original", seed: 0, sceneOverrides: {} },
      baselineExperimentId: investigationId, budget: { wallTimeMs: 1000, maxExperimentsPerEnv: 1, maxCandidatesPerEnv: 1, maxFinalCandidates: 1 },
      idempotencyKey: "owner-only", workspaceId: workspace.id, createdAtMs: 1, updatedAtMs: 1,
    }));
    expect(await guest.query(api.investigations.list, {})).toEqual([]);
    await expect(guest.query(api.investigations.workspace, { investigationId })).rejects.toThrow("unauthorized");
    await t.run((ctx) => ctx.db.insert("investigations", {
      appId: "22222222-2222-4222-8222-222222222222", title: "Shared leftover", state: "capturing", cancelStatus: "none", cancelEpoch: 0, version: 1,
      requestedEnvironments: 1, baselineCase: { caseId: "baseline", suite: "original", seed: 0, sceneOverrides: {} },
      baselineExperimentId: "22222222-2222-4222-8222-222222222222", budget: { wallTimeMs: 1000, maxExperimentsPerEnv: 1, maxCandidatesPerEnv: 1, maxFinalCandidates: 1 },
      idempotencyKey: "shared-leftover", createdAtMs: 2, updatedAtMs: 2,
    }));
    expect((await owner.query(api.investigations.list, {})).map((row) => row.title)).toEqual(["Owner only"]);
    const { code } = await owner.mutation(api.workspaces.createInvite, {});
    await guest.mutation(api.auth.redeemInvite, { inviteCode: code });
    expect((await guest.query(api.investigations.list, {}))[0]?.title).toBe("Owner only");
  });
});
