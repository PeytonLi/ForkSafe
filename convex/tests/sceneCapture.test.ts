import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api.js";
import schema from "../schema.js";
import { caseJsonFor } from "../lib/caseJson.js";
import { pickFirstFailure, type FuzzGrid } from "../lib/sceneSearch.js";
import dividerGrid from "./fuzz-divider.json";
import pushGapGrid from "./fuzz-push-gap.json";

const modules = import.meta.glob("../**/*.ts");
const token = "scene-capture-test-token";
const sha = "a".repeat(64);

beforeEach(() => {
  vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
  vi.stubEnv("FORKSAFE_DEV_ANONYMOUS_UI", "false");
  vi.stubEnv("CONVEX_CLOUD_URL", "https://hosted.convex.cloud");
  vi.stubEnv("DAYTONA_MODE", "");
  vi.stubEnv("DAYTONA_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

async function withBundles(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["bundle"]));
    for (const key of ["simulator", "baseline_controller"] as const) {
      await ctx.db.insert("bundles", { key, storageId, sha256: sha, bytes: 6, uploadedAtMs: 1 });
    }
  });
}

const captureArgs = (taskFamily: string, sceneOverrides: Record<string, number>, suffix: string) => ({
  title: "Scene capture test",
  taskFamily,
  seed: 7,
  sceneOverrides,
  requestedEnvironments: 2,
  idempotencyKey: suffix,
  serviceToken: token,
});

describe("scene capture contract", () => {
  it("rejects legacy keys, out-of-range values, and unknown families before bundle or Daytona checks", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.investigations.capture, captureArgs("divider_pick_place", { divider_x: 0.5 }, "legacy"))).resolves.toMatchObject({
      accepted: false,
      reason: 'divider_x isn\'t a setting for "Pick and place over a divider".',
    });
    await expect(t.mutation(api.investigations.capture, captureArgs("divider_pick_place", { dividerDx: 0.5 }, "range"))).resolves.toMatchObject({
      accepted: false,
      reason: "Move divider away from robot must be between -0.10 m and 0.10 m.",
    });
    await expect(t.mutation(api.investigations.capture, captureArgs("unknown", {}, "unknown"))).resolves.toMatchObject({
      accepted: false,
      reason: 'Unknown task "unknown".',
    });
    expect(await t.run((ctx) => ctx.db.query("investigations").collect())).toEqual([]);
  });

  it("stores the selected divider family and baseline case", async () => {
    vi.stubEnv("DAYTONA_MODE", "cloud");
    vi.stubEnv("DAYTONA_API_KEY", "test-placeholder");
    const t = convexTest(schema, modules);
    await withBundles(t);
    const result = await t.mutation(api.investigations.capture, captureArgs("divider_pick_place", { dividerDx: 0.02 }, "divider"));
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const row = await t.run((ctx) => ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", result.investigationId)).unique());
    expect(row?.baselineCase).toMatchObject({
      caseId: "original-divider-collision",
      suite: "original",
      taskFamily: "divider_pick_place",
      sceneOverrides: { dividerDx: 0.02 },
      description: "Captured baseline failure",
    });
  });

  it("accepts push-gap settings and rejects divider-only keys", async () => {
    vi.stubEnv("DAYTONA_MODE", "cloud");
    vi.stubEnv("DAYTONA_API_KEY", "test-placeholder");
    const t = convexTest(schema, modules);
    await withBundles(t);
    const rejected = await t.mutation(api.investigations.capture, captureArgs("push_through_gap", { dividerDx: 0.02 }, "push-invalid"));
    expect(rejected).toMatchObject({ accepted: false });
    const accepted = await t.mutation(api.investigations.capture, captureArgs("push_through_gap", { gapWidth: 0.08, gapDx: -0.02 }, "push-valid"));
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;
    const row = await t.run((ctx) => ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", accepted.investigationId)).unique());
    expect(row?.baselineCase).toMatchObject({ caseId: "push-gap-aligned", taskFamily: "push_through_gap", sceneOverrides: { gapWidth: 0.08, gapDx: -0.02 } });
  });

  it("returns a blocked failure-search response when Daytona is not configured", async () => {
    const t = convexTest(schema, modules);
    await expect(t.action(api.sceneSearch.findFailure, { taskFamily: "divider_pick_place", serviceToken: token })).resolves.toMatchObject({
      mode: "blocked",
      found: false,
      reason: expect.stringContaining("DAYTONA_API_KEY"),
    });
  });
});

describe("generated scene payload and fuzz selection", () => {
  it("includes taskFamily in the case payload when present", () => {
    expect(caseJsonFor({
      caseId: "push-gap-aligned",
      suite: "original",
      seed: 7,
      sceneOverrides: { gapWidth: 0.08 },
      taskFamily: "push_through_gap",
    })).toEqual({
      caseId: "push-gap-aligned",
      suite: "original",
      seed: 7,
      sceneOverrides: { gapWidth: 0.08 },
      taskFamily: "push_through_gap",
    });
  });

  it.each([
    ["divider fuzz fixture", dividerGrid as unknown as FuzzGrid, "divider_pick_place"],
    ["push-gap fuzz fixture", pushGapGrid as unknown as FuzzGrid, "push_through_gap"],
  ] as const)("selects valid failures from the local %s", (_name, grid, family) => {
    const result = pickFirstFailure(grid, family);
    expect(result.samples).toBeGreaterThan(0);
    expect(result.failures).toBeGreaterThanOrEqual(0);
    if (result.found) {
      expect(result.taskFamily).toBe(family);
      expect(result.caseId).toBe(family === "divider_pick_place" ? "original-divider-collision" : "push-gap-aligned");
    } else {
      expect(result.reason).toBeTruthy();
    }
  });

  it("skips invalid runs and out-of-range divider samples", () => {
    const result = pickFirstFailure({
      n: 3,
      summary: { failCount: 3 },
      samples: [
        { passed: false, failureKind: "invalid_run", sceneOverrides: { dividerDx: 0 }, seed: 1 },
        { passed: false, failureKind: "forbidden_contact", sceneOverrides: { dividerDx: 0.25 }, seed: 2 },
        { passed: false, failureKind: "forbidden_contact", sceneOverrides: { dividerDx: 0.05 }, seed: 3 },
      ],
    }, "divider_pick_place");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.sceneOverrides.dividerDx).toBe(0.05);
      expect(result.seed).toBe(3);
    }
  });
});
