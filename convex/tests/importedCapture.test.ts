import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api.js";
import { sha256Hex } from "../lib/controllerDiff.js";
import schema from "../schema.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<unknown>> }).glob("../**/*.ts");
const token = "INTEGRATION_SHARED_SECRET";
const validController = "def plan(scene):\n    return [{\"skill\": \"open_gripper\"}]\n";

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

function captureArgs(controllerSource: string) {
  return {
    title: "Clip on the tall divider",
    taskFamily: "divider_pick_place",
    seed: 12,
    sceneOverrides: { dividerHeight: 0.15 },
    requestedEnvironments: 1,
    controllerSource,
    idempotencyKey: crypto.randomUUID(),
    serviceToken: token,
  };
}

describe("imported controller capture", () => {
  beforeEach(() => {
    vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
    vi.stubEnv("DAYTONA_MODE", "");
    vi.stubEnv("DAYTONA_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects a controller without def plan and stores nothing when Daytona is unset", async () => {
    delete process.env.DAYTONA_MODE;
    delete process.env.DAYTONA_API_KEY;
    const t = createTest();
    const result = await t.mutation(api.investigations.capture, captureArgs("return []\n"));
    expect(result).toMatchObject({ accepted: false, mode: "live" });
    expect(await t.run((ctx) => ctx.db.query("controllerSources").collect())).toEqual([]);
  });

  it("still refuses a valid controller when Daytona is not cloud", async () => {
    const t = createTest();
    const result = await t.mutation(api.investigations.capture, captureArgs(validController));
    expect(result).toMatchObject({
      accepted: false,
      reason: "capture needs a Daytona execution sandbox; DAYTONA_API_KEY is not configured",
    });
    expect(await t.run((ctx) => ctx.db.query("controllerSources").collect())).toEqual([]);
  });

  it("stores the imported controller hash when Daytona and bundles are present", async () => {
    vi.stubEnv("DAYTONA_MODE", "cloud");
    vi.stubEnv("DAYTONA_API_KEY", "test");
    const t = createTest();
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["bundle"]));
      for (const key of ["simulator", "baseline_controller"] as const) {
        await ctx.db.insert("bundles", { key, storageId, sha256: "a".repeat(64), bytes: 6, uploadedAtMs: 1 });
      }
    });
    const result = await t.mutation(api.investigations.capture, captureArgs(validController));
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const digest = await sha256Hex(validController);
    const stored = await t.run(async (ctx) => ({
      sources: await ctx.db.query("controllerSources").collect(),
      investigation: await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", result.investigationId)).unique(),
    }));
    expect(stored.sources).toEqual([
      expect.objectContaining({
        controllerSha256: digest,
        source: validController,
        bytes: new TextEncoder().encode(validController).byteLength,
      }),
    ]);
    expect(stored.investigation).toMatchObject({ controllerChoice: "imported", controllerSha256: digest });
  });
});
