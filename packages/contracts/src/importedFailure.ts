import { isTaskFamily, validateSceneOverrides } from "./scenes.js";

export const MAX_CONTROLLER_BYTES = 64 * 1024;

export type ImportedFailureInput = {
  title?: string;
  taskFamily: string;
  seed: number;
  sceneOverrides: Record<string, number>;
  controllerSource: string;
};

export type ImportedFailure = {
  title: string;
  taskFamily: "divider_pick_place" | "push_through_gap";
  seed: number;
  sceneOverrides: Record<string, number>;
  controllerSource: string;
};

const PLAN = /\bdef\s+plan\s*\(/;

const FORBIDDEN = [
  "import os",
  "import subprocess",
  "import socket",
  "import pathlib",
  "import importlib",
  "import sys",
  "from os",
  "from subprocess",
  "from socket",
  "from pathlib",
  "from importlib",
  "from sys",
  "open(",
  "exec(",
  "eval(",
  "__import__",
  "compile(",
] as const;

const DEFAULT_TITLE = "Imported failure";

export function validateImportedFailure(
  input: ImportedFailureInput,
): { ok: true; value: ImportedFailure } | { ok: false; reason: string } {
  const title = resolvedTitle(input.title);
  if (typeof title !== "string") return title;

  if (!Number.isInteger(input.seed) || input.seed < 0) {
    return { ok: false, reason: "Seed must be a non-negative integer." };
  }

  if (!isTaskFamily(input.taskFamily)) {
    return { ok: false, reason: `Unknown task "${input.taskFamily}".` };
  }

  const scene = validateSceneOverrides(input.taskFamily, input.sceneOverrides);
  if (!scene.ok) return scene;

  const bytes = new TextEncoder().encode(input.controllerSource).length;
  if (bytes < 1 || bytes > MAX_CONTROLLER_BYTES) {
    return { ok: false, reason: `Controller source must be between 1 and ${MAX_CONTROLLER_BYTES} bytes.` };
  }

  if (!PLAN.test(input.controllerSource)) {
    return { ok: false, reason: "Controller must define plan(scene)." };
  }

  for (const snippet of FORBIDDEN) {
    if (input.controllerSource.includes(snippet)) {
      return { ok: false, reason: `Controller must not contain "${snippet}".` };
    }
  }

  return {
    ok: true,
    value: {
      title,
      taskFamily: input.taskFamily,
      seed: input.seed,
      sceneOverrides: { ...input.sceneOverrides },
      controllerSource: input.controllerSource,
    },
  };
}

function resolvedTitle(title: string | undefined): string | { ok: false; reason: string } {
  if (title === undefined || title.trim() === "") return DEFAULT_TITLE;
  if (title.length > 200) return { ok: false, reason: "Title must be at most 200 characters." };
  return title;
}
