import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api.js";
import { fuzzSearchFlags } from "../lib/sceneSearch.js";
import schema from "../schema.js";

const modules = import.meta.glob("../**/*.ts");
const token = "find-failure-center-token";

beforeEach(() => {
  vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
  vi.stubEnv("FORKSAFE_DEV_ANONYMOUS_UI", "false");
  vi.stubEnv("CONVEX_CLOUD_URL", "https://hosted.convex.cloud");
  vi.stubEnv("DAYTONA_MODE", "");
  vi.stubEnv("DAYTONA_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("fuzz search flags", () => {
  it("quotes center overrides and appends the seed", () => {
    expect(fuzzSearchFlags({
      seed: 4,
      centerOverrides: { dividerDx: 0.04, cubeDy: -0.02 },
    })).toEqual({
      ok: true,
      flags: `--center-overrides '{"cubeDy":-0.02,"dividerDx":0.04}' --seed 4`,
    });
    expect(fuzzSearchFlags({ seed: 1 })).toEqual({ ok: true, flags: "--seed 1" });
    expect(fuzzSearchFlags({ seed: 0, centerOverrides: {} })).toEqual({
      ok: true,
      flags: "--center-overrides '{}' --seed 0",
    });
  });

  it("rejects non-finite overrides and unsafe seeds before building a command", () => {
    expect(fuzzSearchFlags({ seed: 1, centerOverrides: { dividerDx: Number.NaN } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("finite"),
    });
    expect(fuzzSearchFlags({ seed: 1, centerOverrides: { speedScale: Number.POSITIVE_INFINITY } })).toMatchObject({
      ok: false,
    });
    expect(fuzzSearchFlags({ seed: 1, centerOverrides: { "a'b": 1 } })).toMatchObject({ ok: false });
    expect(fuzzSearchFlags({ seed: -1 }).ok).toBe(false);
    expect(fuzzSearchFlags({ seed: 1.5 }).ok).toBe(false);
    expect(fuzzSearchFlags({ seed: Number.NaN }).ok).toBe(false);
  });
});

describe("findFailure center args", () => {
  it("returns the validator reason for invalid overrides before a sandbox", async () => {
    vi.stubEnv("DAYTONA_MODE", "cloud");
    vi.stubEnv("DAYTONA_API_KEY", "test-placeholder");
    const t = convexTest(schema, modules);
    await expect(t.action(api.sceneSearch.findFailure, {
      taskFamily: "divider_pick_place",
      sceneOverrides: { dividerDx: 0.5 },
      seed: 3,
      serviceToken: token,
    })).resolves.toEqual({
      mode: "live",
      found: false,
      samples: 0,
      failures: 0,
      reason: "Move divider away from robot must be between -0.10 m and 0.10 m.",
    });
    await expect(t.action(api.sceneSearch.findFailure, {
      taskFamily: "divider_pick_place",
      sceneOverrides: { gapDx: 0.02 },
      serviceToken: token,
    })).resolves.toMatchObject({
      mode: "live",
      found: false,
      samples: 0,
      failures: 0,
      reason: 'gapDx isn\'t a setting for "Pick and place over a divider".',
    });
  });

  it("keeps today's blocked response when overrides are omitted", async () => {
    const t = convexTest(schema, modules);
    await expect(t.action(api.sceneSearch.findFailure, {
      taskFamily: "divider_pick_place",
      serviceToken: token,
    })).resolves.toMatchObject({
      mode: "blocked",
      found: false,
      samples: 0,
      failures: 0,
      reason: expect.stringContaining("DAYTONA_API_KEY"),
    });
  });

  it("still requires a sandbox when the overrides are valid", async () => {
    const t = convexTest(schema, modules);
    await expect(t.action(api.sceneSearch.findFailure, {
      taskFamily: "push_through_gap",
      sceneOverrides: { gapWidth: 0.09 },
      seed: 2,
      serviceToken: token,
    })).resolves.toMatchObject({
      mode: "blocked",
      found: false,
      samples: 0,
      failures: 0,
      reason: expect.stringContaining("DAYTONA_API_KEY"),
    });
  });
});
