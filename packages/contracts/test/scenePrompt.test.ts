import { describe, expect, it } from "vitest";
import { SCENE_OVERRIDE_RANGES, TASK_FAMILY_SPECS, validateSceneOverrides } from "../src/index.js";
import { compileScenePrompt } from "../src/scenePrompt.js";

function unrecognized(taskFamily: "divider_pick_place" | "push_through_gap"): string {
  const labels = labelsFor(taskFamily);
  const list = `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
  return `This scene can change ${list}. Name one of those and a direction or a distance.`;
}

function dividerScene(partial: Record<string, number> = {}): Record<string, number> {
  return {
    cubeDx: 0,
    cubeDy: 0,
    targetDx: 0,
    targetDy: 0,
    dividerDx: 0,
    dividerDy: 0,
    dividerHeight: 0.1,
    speedScale: 1,
    ...partial,
  };
}

function pushScene(partial: Record<string, number> = {}): Record<string, number> {
  return {
    cubeDx: 0,
    cubeDy: 0,
    targetDx: 0,
    targetDy: 0,
    gapDx: 0,
    gapWidth: 0.07,
    speedScale: 1,
    ...partial,
  };
}

function labelsFor(taskFamily: "divider_pick_place" | "push_through_gap"): string[] {
  return TASK_FAMILY_SPECS[taskFamily].overrideKeys.map((key) => SCENE_OVERRIDE_RANGES[key].label);
}

describe("compileScenePrompt", () => {
  it("moves the divider 6 cm closer and keeps the rest of the scene", () => {
    const current = dividerScene({ dividerDx: 0.01, cubeDx: 0.02, speedScale: 1.2 });
    const text = "6 cm closer on the divider";
    const result = compileScenePrompt("divider_pick_place", text, current);

    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.applied).toEqual([{
      key: "dividerDx",
      label: "Move divider away from robot",
      value: -0.05,
      phrase: text,
    }]);
    expect(result.overrides).toEqual({ ...current, dividerDx: -0.05 });
    expect(current.dividerDx).toBe(0.01);
    expect(validateSceneOverrides("divider_pick_place", result.overrides)).toEqual({ ok: true });
  });

  it("accepts centimetres and metres, glued or spaced", () => {
    expect(compileScenePrompt("divider_pick_place", "Move the divider 6cm closer", dividerScene()).overrides.dividerDx).toBe(-0.06);
    expect(compileScenePrompt("divider_pick_place", "Move the divider 0.06 m away", dividerScene()).overrides.dividerDx).toBe(0.06);
    expect(compileScenePrompt("divider_pick_place", "Move the divider 0.06m further", dividerScene()).overrides.dividerDx).toBe(0.06);
    expect(compileScenePrompt("divider_pick_place", "Move the cube 0.02 closer", dividerScene()).overrides.cubeDx).toBe(-0.02);
  });

  it("steps left once when no distance is given and records that left is +dy", () => {
    const current = dividerScene({ cubeDy: 0.01 });
    const text = "Move the cube left";
    const result = compileScenePrompt("divider_pick_place", text, current);

    expect(result.ok).toBe(true);
    expect(result.overrides.cubeDy).toBe(0.015);
    expect(result.applied).toEqual([{
      key: "cubeDy",
      label: "Move cube sideways",
      value: 0.015,
      phrase: `${text} (left is +dy)`,
    }]);
  });

  it("steps right as -dy", () => {
    const text = "Move the target right";
    const result = compileScenePrompt("divider_pick_place", text, dividerScene({ targetDy: 0.01 }));
    expect(result.ok).toBe(true);
    expect(result.overrides.targetDy).toBe(0.005);
    expect(result.applied[0]?.phrase).toBe(`${text} (right is -dy)`);
  });

  it("speeds the robot up by one slider step", () => {
    const text = "Make the robot faster";
    const result = compileScenePrompt("divider_pick_place", text, dividerScene());
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.applied).toEqual([{
      key: "speedScale",
      label: "Robot speed",
      value: 1.05,
      phrase: text,
    }]);
    expect(compileScenePrompt("push_through_gap", "slower", pushScene({ speedScale: 1.2 })).overrides.speedScale).toBe(1.15);
    expect(compileScenePrompt("divider_pick_place", "faster by 0.2", dividerScene()).overrides.speedScale).toBe(1.2);
  });

  it("refuses a second arm and names every setting this scene can change", () => {
    const current = dividerScene({ cubeDx: 0.01 });
    const result = compileScenePrompt("divider_pick_place", "Add a second arm", current);
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.overrides).toEqual(current);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain("This scene cannot represent a second arm.");
    for (const label of labelsFor("divider_pick_place")) expect(result.refusals[0]).toContain(label);
  });

  it("applies the valid part of a mixed sentence and refuses the rest", () => {
    const text = "Move the cube 2 cm away and add a conveyor";
    const result = compileScenePrompt("divider_pick_place", text, dividerScene());
    expect(result.ok).toBe(true);
    expect(result.overrides.cubeDx).toBe(0.02);
    expect(result.applied.map((item) => item.key)).toEqual(["cubeDx"]);
    expect(result.applied[0]?.phrase).toBe(text);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain("This scene cannot represent a conveyor.");
    for (const label of labelsFor("divider_pick_place")) expect(result.refusals[0]).toContain(label);
  });

  it("refuses divider height on push through a gap and still applies a gap change", () => {
    const refused = compileScenePrompt("push_through_gap", "Make the divider taller", pushScene());
    expect(refused.ok).toBe(false);
    expect(refused.applied).toEqual([]);
    expect(refused.overrides.dividerHeight).toBeUndefined();
    expect(refused.refusals[0]).toContain('Divider height is not a setting for "Push through a gap".');
    for (const label of labelsFor("push_through_gap")) expect(refused.refusals[0]).toContain(label);

    const mixed = compileScenePrompt("push_through_gap", "Make the divider taller and the gap wider", pushScene());
    expect(mixed.ok).toBe(true);
    expect(mixed.overrides.gapWidth).toBe(0.075);
    expect(mixed.overrides.dividerHeight).toBeUndefined();
    expect(mixed.applied.map((item) => item.key)).toEqual(["gapWidth"]);
    expect(mixed.refusals[0]).toContain("Divider height");
  });

  it("refuses gap width on the divider task", () => {
    const result = compileScenePrompt("divider_pick_place", "Widen the gap by 1 cm", dividerScene());
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.overrides.gapWidth).toBeUndefined();
    expect(result.refusals[0]).toContain('Gap width is not a setting for "Pick and place over a divider".');
  });

  it("clamps at the range edge", () => {
    const high = compileScenePrompt("divider_pick_place", "Move the divider 6 cm away", dividerScene({ dividerDx: 0.08 }));
    expect(high.ok).toBe(true);
    expect(high.overrides.dividerDx).toBe(0.1);
    expect(high.applied[0]?.value).toBe(0.1);

    const low = compileScenePrompt("divider_pick_place", "Move the divider 6 cm closer", dividerScene({ dividerDx: -0.09 }));
    expect(low.overrides.dividerDx).toBe(-0.1);

    const speed = compileScenePrompt("divider_pick_place", "Make the robot faster", dividerScene({ speedScale: 1.98 }));
    expect(speed.overrides.speedScale).toBe(2);
  });

  it("refuses empty or unrecognized text with one sentence", () => {
    const current = dividerScene({ cubeDx: 0.02, gapWidth: 0.2, ignored: 1 });
    const empty = compileScenePrompt("divider_pick_place", "   ", current);
    expect(empty).toEqual({
      ok: false,
      overrides: { ...dividerScene(), cubeDx: 0.02 },
      applied: [],
      refusals: [unrecognized("divider_pick_place")],
    });
    expect(compileScenePrompt("divider_pick_place", "", current).refusals).toEqual([unrecognized("divider_pick_place")]);
    expect(compileScenePrompt("push_through_gap", "hello there", pushScene()).refusals).toEqual([unrecognized("push_through_gap")]);
  });

  it("composes two directions and sets a scalar to an absolute value", () => {
    const moved = compileScenePrompt("divider_pick_place", "Move the cube 2 cm away and 1 cm left", dividerScene());
    expect(moved.ok).toBe(true);
    expect(moved.overrides.cubeDx).toBe(0.02);
    expect(moved.overrides.cubeDy).toBe(0.01);
    expect(moved.applied.map((item) => item.key)).toEqual(["cubeDx", "cubeDy"]);
    expect(moved.applied[1]?.phrase).toContain("left is +dy");

    const height = compileScenePrompt("divider_pick_place", "Set the divider height to 12 cm", dividerScene());
    expect(height.ok).toBe(true);
    expect(height.overrides.dividerHeight).toBe(0.12);
    expect(height.applied[0]?.key).toBe("dividerHeight");
  });

  it("reads ordinary directions, scalars, and stacked refusals", () => {
    expect(compileScenePrompt("divider_pick_place", "Move the divider further away", dividerScene()).overrides.dividerDx).toBe(0.005);
    expect(compileScenePrompt("divider_pick_place", "make the divider 2 cm taller", dividerScene()).overrides.dividerHeight).toBe(0.12);
    expect(compileScenePrompt("divider_pick_place", "lower the divider", dividerScene()).overrides.dividerHeight).toBe(0.095);
    expect(compileScenePrompt("divider_pick_place", "Set speed to 1.5", dividerScene()).overrides.speedScale).toBe(1.5);
    expect(compileScenePrompt("push_through_gap", "move the gap 3 cm away", pushScene()).overrides.gapDx).toBe(0.03);
    expect(compileScenePrompt("push_through_gap", "narrow the gap", pushScene()).overrides.gapWidth).toBe(0.065);

    const diagonal = compileScenePrompt("divider_pick_place", "Move the cube 2 cm left and 3 cm away", dividerScene());
    expect(diagonal.overrides.cubeDy).toBe(0.02);
    expect(diagonal.overrides.cubeDx).toBe(0.03);
    expect(diagonal.applied.find((item) => item.key === "cubeDy")?.phrase).toContain("left is +dy");

    const robot = compileScenePrompt("divider_pick_place", "move the robot left", dividerScene());
    expect(robot.ok).toBe(false);
    expect(robot.applied).toEqual([]);
    expect(robot.refusals[0]).toContain("moving the robot sideways");

    const stacked = compileScenePrompt("divider_pick_place", "add a human and a conveyor", dividerScene());
    expect(stacked.ok).toBe(false);
    expect(stacked.refusals.map((line) => /human|conveyor/.exec(line)?.[0]).sort()).toEqual(["conveyor", "human"]);

    const task = compileScenePrompt("divider_pick_place", "switch to a different task and move the cube 1cm right", dividerScene());
    expect(task.ok).toBe(true);
    expect(task.overrides.cubeDy).toBe(-0.01);
    expect(task.refusals[0]).toContain("a different task");
    expect(task.applied[0]?.phrase).toContain("right is -dy");
  });

  it("refuses sideways gap motion and a human while keeping a valid cube move", () => {
    const gap = compileScenePrompt("push_through_gap", "Move the gap left", pushScene());
    expect(gap.ok).toBe(false);
    expect(gap.applied).toEqual([]);
    expect(gap.refusals[0]).toContain("This scene cannot represent moving the gap sideways.");

    const human = compileScenePrompt("divider_pick_place", "Move the cube 1 cm closer to the human", dividerScene());
    expect(human.ok).toBe(true);
    expect(human.overrides.cubeDx).toBe(-0.01);
    expect(human.refusals[0]).toContain("This scene cannot represent a human.");
  });
});
