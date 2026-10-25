import {
  DESCRIBE_HINTS, SCENE_DEFAULTS, SCENE_OVERRIDE_RANGES, TASK_FAMILIES, TASK_FAMILY_SPECS,
  isTaskFamily, validateSceneOverrides, type SceneOverrideKey, type TaskFamily,
} from "./scenes.js";

export type DescribeResult =
  | { status: "matched"; taskFamily: TaskFamily; overrides: Record<string, number>; explanation: string }
  | { status: "unsupported"; explanation: string };

export type DescribeOutcome = DescribeResult & { mode: "llm" | "rules" | "fixture"; fallback?: boolean };
export const DESCRIBE_MAX_CHARS = 500;

export function unsupportedScene(): DescribeResult {
  return { status: "unsupported", explanation: `ForkSafe can't simulate that yet. It supports: ${TASK_FAMILIES.map((family) => TASK_FAMILY_SPECS[family].title).join(", ")}.` };
}

export function describeInputError(text: string): DescribeResult | null {
  if (!text.trim()) return { status: "unsupported", explanation: "Type a short description of the scene first." };
  if (text.length > DESCRIBE_MAX_CHARS) return { status: "unsupported", explanation: "Describe the scene in 500 characters or fewer." };
  return null;
}

function has(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => new RegExp(`\\b${term}\\b`).test(text));
}

export function normalizeDescribedOverrides(family: TaskFamily, input: Record<string, unknown>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const key of TASK_FAMILY_SPECS[family].overrideKeys) {
    const raw = input[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("Invalid scene number");
    const { min, max, step } = SCENE_OVERRIDE_RANGES[key];
    const clamped = Math.min(max, Math.max(min, raw));
    const value = Number(Math.min(max, Math.max(min, min + Math.round((clamped - min) / step) * step)).toFixed(5));
    if (value !== SCENE_DEFAULTS[key]) output[key] = value;
  }
  if (!validateSceneOverrides(family, output).ok) throw new Error("Invalid scene settings");
  return output;
}

export function explainScene(family: TaskFamily, overrides: Record<string, number>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(overrides)) {
    const key = name as SceneOverrideKey;
    if (key === "speedScale") parts.push(`robot speed ${value}×`);
    else if (key === "gapWidth") parts.push(`${value < SCENE_DEFAULTS[key] ? "narrower" : "wider"} gap (${value} m)`);
    else if (key === "dividerHeight") parts.push(`${value < SCENE_DEFAULTS[key] ? "lower" : "taller"} divider (${value} m)`);
    else if (key === "binWidth") parts.push(`${value < SCENE_DEFAULTS[key] ? "narrower" : "wider"} bin (${value} m)`);
    else {
      const object = key.replace(/D[xy]$/, "");
      const direction = key === "gapDx" ? (value > 0 ? "along the wall" : "back along the wall")
        : key.endsWith("Dy") ? (value > 0 ? "left" : "right") : value > 0 ? "further away" : "closer";
      parts.push(`${object} moved ${direction} ${Math.abs(value)} m`);
    }
  }
  const detail = parts.length ? parts.join(", ") : "standard scene";
  return `Matched: ${TASK_FAMILY_SPECS[family].title}. ${detail[0]!.toUpperCase()}${detail.slice(1)}.`;
}

export function describeScene(source: string): DescribeResult {
  const error = describeInputError(source);
  if (error) return error;
  const text = source.toLowerCase().replace(/[^a-z0-9.×,;\-\s]/g, " ").replace(/\s+/g, " ");
  if (has(text, ["drone", "dog", "cat", "car", "truck", "human", "bird", "plane", "boat", "walking", "flying", "swimming", "driving", "landing"])) return unsupportedScene();
  const ranked = Object.entries(DESCRIBE_HINTS).map(([family, hints]) => ({
    family, score: hints.strong.filter((term) => has(text, [term])).length * 2 + hints.weak.filter((term) => has(text, [term])).length,
  })).sort((a, b) => b.score - a.score);
  const exclusive = Object.entries(DESCRIBE_HINTS).find(([, hints]) => hints.exclusive && has(text, hints.exclusive));
  const match = exclusive ? { family: exclusive[0], score: 2 } : ranked[0];
  if (!match || match.score < 2 || !isTaskFamily(match.family)) return unsupportedScene();
  const family = match.family;
  const settings: Record<string, number> = {};
  if (has(text, ["very narrow", "really narrow", "very tight"])) settings.gapWidth = 0.05;
  else if (has(text, ["narrow", "narrower", "tight", "tighter", "small opening"])) settings.gapWidth = 0.06;
  else if (has(text, ["very wide"])) settings.gapWidth = 0.12;
  else if (has(text, ["wide", "wider", "large", "big"])) settings.gapWidth = 0.09;
  if (has(text, ["very tall", "very high"])) settings.dividerHeight = 0.2;
  else if (has(text, ["tall", "taller", "high", "higher"])) settings.dividerHeight = 0.15;
  else if (has(text, ["very low", "very short"])) settings.dividerHeight = 0.04;
  else if (has(text, ["low", "lower", "short", "shorter"])) settings.dividerHeight = 0.06;
  const speed = text.match(/(-?\d+(?:\.\d+)?)\s*(?:×|x\b|times\b)/);
  if (speed) settings.speedScale = Number(speed[1]);
  else if (has(text, ["twice as fast", "double speed"])) settings.speedScale = 2;
  else if (has(text, ["half speed", "half as fast"])) settings.speedScale = 0.5;
  else if (has(text, ["much faster", "very fast", "a lot faster"])) settings.speedScale = 1.6;
  else if (has(text, ["faster", "fast", "quick", "quickly", "quicker"])) settings.speedScale = 1.3;
  else if (has(text, ["much slower", "very slow"])) settings.speedScale = 0.6;
  else if (has(text, ["slower", "slow", "slowly", "carefully", "gently"])) settings.speedScale = 0.75;
  const nouns: Record<string, string> = { cube: "cube", box: "cube", block: "cube", object: "cube", target: "target", goal: "target", spot: "target", mark: "target", divider: "divider", barrier: "divider", wall: "divider", gap: "gap", opening: "gap", bin: "bin" };
  for (const clause of text.split(/[,;]|\b(?:and|but|then)\b/)) {
    let object: string | undefined;
    for (const word of clause.match(/\b[a-z]+\b/g) ?? []) {
      if (nouns[word]) object = nouns[word];
      if (!object) continue;
      const axis = ["left", "right"].includes(word) ? "Dy" : ["further", "farther", "away", "closer", "nearer"].includes(word) ? "Dx" : null;
      if (!axis) continue;
      const small = has(clause, ["a little", "slightly", "a bit"]);
      settings[object + axis] = (["right", "closer", "nearer"].includes(word) ? -1 : 1) * (small ? 0.025 : 0.05);
    }
  }
  const overrides = normalizeDescribedOverrides(family, settings);
  return { status: "matched", taskFamily: family, overrides, explanation: explainScene(family, overrides) };
}
