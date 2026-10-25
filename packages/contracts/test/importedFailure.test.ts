import { describe, expect, it } from "vitest";
import { MAX_CONTROLLER_BYTES, validateImportedFailure, type ImportedFailureInput } from "../src/importedFailure.js";

const PLAN = `def plan(scene):
    return [{"skill": "open_gripper"}]`;

function input(overrides: Partial<ImportedFailureInput> = {}): ImportedFailureInput {
  return {
    taskFamily: "divider_pick_place",
    seed: 1,
    sceneOverrides: {},
    controllerSource: PLAN,
    ...overrides,
  };
}

describe("validateImportedFailure", () => {
  it("accepts a valid divider failure", () => {
    const sceneOverrides = { dividerHeight: 0.15 };
    const result = validateImportedFailure(input({
      title: "Clip on the tall divider",
      seed: 12,
      sceneOverrides,
    }));
    expect(result).toEqual({
      ok: true,
      value: {
        title: "Clip on the tall divider",
        taskFamily: "divider_pick_place",
        seed: 12,
        sceneOverrides: { dividerHeight: 0.15 },
        controllerSource: PLAN,
      },
    });
    if (!result.ok) return;
    expect(result.value.sceneOverrides).not.toBe(sceneOverrides);
    expect(result.value.controllerSource).toBe(PLAN);
  });

  it("accepts a valid push failure", () => {
    const sceneOverrides = { gapWidth: 0.08 };
    const result = validateImportedFailure(input({
      title: "Cube misses the gap",
      taskFamily: "push_through_gap",
      seed: 3,
      sceneOverrides,
    }));
    expect(result).toEqual({
      ok: true,
      value: {
        title: "Cube misses the gap",
        taskFamily: "push_through_gap",
        seed: 3,
        sceneOverrides: { gapWidth: 0.08 },
        controllerSource: PLAN,
      },
    });
    if (!result.ok) return;
    expect(result.value.sceneOverrides).not.toBe(sceneOverrides);
  });

  it("rejects a controller missing plan", () => {
    expect(validateImportedFailure(input({
      controllerSource: "def execute(scene):\n    return []\n",
    }))).toEqual({ ok: false, reason: "Controller must define plan(scene)." });
  });

  it("rejects a forbidden import", () => {
    expect(validateImportedFailure(input({
      controllerSource: `import os\n${PLAN}`,
    }))).toEqual({ ok: false, reason: 'Controller must not contain "import os".' });
  });

  it("rejects an oversize controller", () => {
    const bytes = new TextEncoder().encode(PLAN).length;
    const controllerSource = PLAN + " ".repeat(MAX_CONTROLLER_BYTES - bytes + 1);
    expect(new TextEncoder().encode(controllerSource).length).toBe(MAX_CONTROLLER_BYTES + 1);
    expect(validateImportedFailure(input({ controllerSource }))).toEqual({
      ok: false,
      reason: `Controller source must be between 1 and ${MAX_CONTROLLER_BYTES} bytes.`,
    });
  });

  it("rejects a bad scene key", () => {
    expect(validateImportedFailure(input({
      sceneOverrides: { divider_x: 0 },
    }))).toEqual({
      ok: false,
      reason: 'divider_x isn\'t a setting for "Pick and place over a divider".',
    });
  });

  it("uses Imported failure when the title is blank", () => {
    const blank = validateImportedFailure(input({ title: "   " }));
    expect(blank).toEqual({
      ok: true,
      value: {
        title: "Imported failure",
        taskFamily: "divider_pick_place",
        seed: 1,
        sceneOverrides: {},
        controllerSource: PLAN,
      },
    });

    const missing = validateImportedFailure(input());
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value.title).toBe("Imported failure");
  });

  it("rejects a title over 200 characters", () => {
    expect(validateImportedFailure(input({ title: "a".repeat(201) }))).toEqual({
      ok: false,
      reason: "Title must be at most 200 characters.",
    });
  });

  it("rejects a negative seed", () => {
    expect(validateImportedFailure(input({ seed: -1 }))).toEqual({
      ok: false,
      reason: "Seed must be a non-negative integer.",
    });
  });
});
