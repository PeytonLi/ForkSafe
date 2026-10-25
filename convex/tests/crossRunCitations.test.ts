import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api.js";
import schema from "../schema.js";

const modules = import.meta.glob("../**/*.ts");

const investigationId = "11111111-1111-4111-8111-111111111111";
const priorInvestigationId = "99999999-9999-4999-8999-999999999999";
const environmentId = "33333333-3333-4333-8333-333333333333";
const revisionId = "22222222-2222-4222-8222-222222222222";
const candidateId = "44444444-4444-4444-8444-444444444444";
const priorFindingId = "66666666-6666-4666-8666-666666666666";
const artifactId = "77777777-7777-4777-8777-777777777777";
const attemptId = "88888888-8888-4888-8888-888888888888";
const sha = "e".repeat(64);

async function seed(t: ReturnType<typeof convexTest>, { offer }: { offer: boolean }) {
  await t.run(async (ctx) => {
    await ctx.db.insert("environments", {
      appId: environmentId, investigationId, index: 0, state: "active",
      budgets: { maxExperiments: 20, maxCandidates: 2, maxFactorySessions: 2, wallTimeMs: 600_000 },
      experimentsUsed: 0, candidatesUsed: 0,
    });
    await ctx.db.insert("controllerRevisions", {
      appId: revisionId, investigationId, environmentId, seq: 1,
      controllerSha256: sha, sourceArtifactId: artifactId, changedFunctions: ["plan"],
      createdByAttemptId: attemptId, epoch: 0, spacetimeCommitted: false, createdAtMs: 1,
    });
    // A finding from a *different* (earlier) investigation — the cross-run citation case.
    await ctx.db.insert("findings", {
      appId: priorFindingId, investigationId: priorInvestigationId, environmentId,
      attemptId, epoch: 0, kind: "behavioral_note", claim: "observation",
      summary: "prior run observation", evidence: [], spacetimeCommitted: false, createdAtMs: 1,
    });
    if (offer) {
      await ctx.db.insert("priorHintOffers", {
        investigationId, environmentId, findingId: priorFindingId,
        sourceInvestigationId: priorInvestigationId, rank: 1,
        summary: "hint from earlier run", offeredAtMs: 1,
      });
    }
  });
}

const args = {
  candidateId, investigationId, environmentId, revisionId,
  attemptId, epoch: 0, basedOnFindings: [priorFindingId],
};

describe("insertCandidate cross-run finding citations", () => {
  it("accepts a prior-run finding offered to this environment", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { offer: true });
    const result = await t.mutation(internal.evidence.insertCandidate, args);
    expect(result).toMatchObject({ duplicate: false });
  });

  it("rejects a prior-run finding that was never offered", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { offer: false });
    await expect(t.mutation(internal.evidence.insertCandidate, {
      ...args, candidateId: "55555555-5555-4555-8555-555555555555",
    })).rejects.toThrow("finding_missing");
  });
});
