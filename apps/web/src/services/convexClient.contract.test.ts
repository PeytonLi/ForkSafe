import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeAll, describe, expect, it } from "vitest";
import { CONVEX_FUNCTIONS as functions, CONVEX_RESPONSE_SCHEMAS as schemas } from "./convexClient";
import type { InvestigationWorkspace } from "./types";

const live = process.env.FORKSAFE_LIVE_CONVEX === "1";
const client = new ConvexHttpClient("https://giant-jellyfish-684.convex.cloud");
const query = (name: string, args = {}) => client.query(makeFunctionReference<"query">(name), args);

describe.skipIf(!live)("hosted web Convex contracts", () => {
  let workspaces: InvestigationWorkspace[];

  beforeAll(async () => {
    const list = schemas.listInvestigations.parse(await query(functions.listInvestigations));
    expect(list.length).toBeGreaterThan(0);
    workspaces = await Promise.all(list.filter((r) => r.state !== "restricted").map(async (r) =>
      schemas.workspace.parse(await query(functions.workspace, { investigationId: r.id }))));
    expect(workspaces.length).toBeGreaterThan(0);
  }, 30_000);

  it("returns contract-valid list, real workspaces, findings, and a workspace-linked replay", async () => {
    for (const workspace of workspaces) {
      schemas.findings.parse(await query(functions.findings, { investigationId: workspace.investigation.id }));
    }
    const experiment = workspaces.flatMap((w) => w.experiments).find((e) => e.replayArtifactId);
    expect(experiment, "a listed workspace must reference a real replay").toBeDefined();
    schemas.replay.parse(await query(functions.replay, { artifactId: experiment!.replayArtifactId }));
  }, 30_000);

  it("validates candidate replay/diff, or returns typed not-found errors if no candidates exist", async () => {
    const candidates = workspaces.flatMap((w) => w.candidates);
    if (candidates.length) {
      for (const candidate of candidates) {
        schemas.candidateReplay.parse(await query(functions.candidateReplay, { candidateId: candidate.id }));
        schemas.candidateDiff.parse(await query(functions.candidateDiff, { candidateId: candidate.id }));
      }
    } else {
      console.info("No hosted candidates: checking typed candidate-not-found responses for replay and diff.");
      for (const name of [functions.candidateReplay, functions.candidateDiff]) {
        const error = await query(name, { candidateId: crypto.randomUUID() }).then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(ConvexError);
        expect((error as ConvexError<string>).data).toBe("candidate not found");
      }
    }
  }, 30_000);

  it("exposes capture, cancel, and review writes but fails closed without authentication", async () => {
    const absentId = crypto.randomUUID();
    await expect(client.mutation(makeFunctionReference<"mutation">(functions.capture), {
      title: "", seed: 0, sceneOverrides: {}, requestedEnvironments: 1,
    })).rejects.toThrow(/unauthorized/i);
    await expect(client.mutation(makeFunctionReference<"mutation">(functions.cancel), { investigationId: absentId })).rejects.toThrow(/unauthorized/i);
    await expect(client.action(makeFunctionReference<"action">(functions.recordReview), {
      investigationId: absentId, candidateId: absentId, evaluationId: absentId,
      controllerSha256: "a".repeat(64), decision: "rejected",
    })).rejects.toThrow(/unauthorized/i);
  }, 30_000);
});
