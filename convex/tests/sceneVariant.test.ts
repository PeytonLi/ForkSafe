import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { sceneVariantFor } from "@forksafe/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api.js";
import schema from "../schema.js";
import { baselineCaseFromJobPayload } from "../runnerHttp.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<unknown>> }).glob("../**/*.ts");
const token = "convex-test-service-token";
const baseline = {
  caseId: "original-divider-collision",
  suite: "original" as const,
  seed: 40,
  sceneOverrides: { cubeDx: 0.1, dividerHeight: 0.15 },
  taskFamily: "divider_pick_place",
  description: "Captured baseline failure",
};

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

describe("baselineCaseFromJobPayload", () => {
  const investigationBaseline = { caseId: "captured", sceneOverrides: { cubeDx: 0 } };

  it("uses the job scene when it has a case id and overrides", () => {
    const simCase = { caseId: "original-divider-collision", seed: 41, sceneOverrides: { cubeDx: 0.095 } };
    expect(baselineCaseFromJobPayload({ simCase, environmentIndex: 1 }, investigationBaseline)).toBe(simCase);
    expect(baselineCaseFromJobPayload({ simCase: { caseId: "empty", sceneOverrides: {} } }, investigationBaseline).caseId).toBe("empty");
  });

  it("keeps the investigation baseline when the job has no scene", () => {
    expect(baselineCaseFromJobPayload(undefined, investigationBaseline)).toBe(investigationBaseline);
    expect(baselineCaseFromJobPayload({}, investigationBaseline)).toBe(investigationBaseline);
    expect(baselineCaseFromJobPayload({ simCase: { seed: 1, sceneOverrides: {} } }, investigationBaseline)).toBe(investigationBaseline);
    expect(baselineCaseFromJobPayload({ simCase: { caseId: "missing-overrides" } }, investigationBaseline)).toBe(investigationBaseline);
    expect(baselineCaseFromJobPayload({ simCase: { caseId: "bad", sceneOverrides: null } }, investigationBaseline)).toBe(investigationBaseline);
  });
});

describe("environment scene variants", () => {
  beforeEach(() => {
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    vi.stubEnv("DAYTONA_MODE", "local");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("stores each environment's scene and returns it from the workspace", async () => {
    const t = createTest();
    const created = await t.mutation(api.investigations.create, {
      title: "Nearby scenes",
      requestedEnvironments: 3,
      baselineCase: baseline,
      idempotencyKey: crypto.randomUUID(),
      serviceToken: token,
    });
    await t.mutation(api.investigations.start, {
      investigationId: created.investigationId,
      expectedVersion: 1,
      serviceToken: token,
    });

    const stored = await t.run(async (ctx) => {
      const environments = (await ctx.db.query("environments").collect()).sort((a, b) => a.index - b.index);
      const jobs = (await ctx.db.query("jobs").collect())
        .filter((job) => job.kind === "factory_session")
        .sort((a, b) => Number(a.payload.environmentIndex) - Number(b.payload.environmentIndex));
      return { environments, jobs };
    });

    expect(stored.environments.map((row) => row.index)).toEqual([0, 1, 2]);
    for (const row of stored.environments) {
      const variant = sceneVariantFor(row.index, baseline);
      expect(row.sceneVariant).toEqual(variant);
      const job = stored.jobs[row.index]!;
      expect(job.payload).toMatchObject({
        environmentIndex: row.index,
        simCase: variant,
      });
      expect(job.payload.priorHints).toEqual([]);
    }
    expect(stored.environments[0]!.sceneVariant).toMatchObject({ seed: baseline.seed, sceneOverrides: baseline.sceneOverrides });
    const nearby = stored.environments[1]!.sceneVariant;
    expect(nearby?.seed).toBe(baseline.seed + 1);
    expect(nearby?.sceneOverrides?.cubeDx).not.toBe(baseline.sceneOverrides.cubeDx);

    const workspace = await t.query(api.investigations.workspace, {
      investigationId: created.investigationId,
      serviceToken: token,
    });
    expect(workspace.environments.map((row) => row.sceneVariant)).toEqual(
      stored.environments.map((row) => row.sceneVariant),
    );
  });
});
