import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TOSS_BIN_DEFAULTS,
  TOSS_BIN_OVERRIDES,
  TOSS_INTO_BIN,
  FailureKind,
  SimCase,
} from "../src/index.js";

describe("toss bin contract", () => {
  it("matches simulator defaults and override ranges", () => {
    const configPath = fileURLToPath(
      new URL("../../../services/simulator/scene_configs/toss_bin.json", import.meta.url),
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(TOSS_INTO_BIN).toBe("toss_into_bin");
    for (const kind of [
      "dropped_early",
      "bounced_out",
      "missed_bin_short",
      "missed_bin_long",
    ]) {
      expect(FailureKind.parse(kind)).toBe(kind);
    }
    expect(
      SimCase.parse({
        caseId: "toss",
        suite: "public",
        taskFamily: "toss_into_bin",
        seed: 0,
      }).taskFamily,
    ).toBe("toss_into_bin");
    expect(TOSS_BIN_DEFAULTS).toEqual({
      objectStart: config.objectStart,
      binHalfExtents: config.binHalfExtents,
      binWallHalfThickness: config.binWallHalfThickness,
      binWallHeight: config.binWallHeight,
      objectHalfSize: config.objectHalfSize,
      objectMass: config.objectMass,
      binCenter: config.binCenter,
    });
    for (const override of TOSS_BIN_OVERRIDES) {
      expect([override.min, override.max]).toEqual(
        config.overrideRanges[override.key],
      );
      expect(override.default).toBe(
        override.kind === "delta"
          ? 0
          : config[override.key] ?? (override.key === "speedScale" ? 1 : undefined),
      );
    }
  });
});
