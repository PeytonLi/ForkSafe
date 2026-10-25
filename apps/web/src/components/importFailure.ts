import { validateImportedFailure, type ImportedFailure } from "../../../../packages/contracts/src/importedFailure.js";

const MAX_IMPORT_BYTES = 64 * 1024;

export interface ImportedSceneFile {
  taskFamily: string;
  seed: number;
  sceneOverrides: Record<string, number>;
  title?: string;
}

export async function readImportedSceneFile(
  file: File,
): Promise<{ ok: true; value: ImportedSceneFile } | { ok: false; reason: string }> {
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, reason: "Scene file is larger than 64 KiB." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { ok: false, reason: "Scene file is not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "Scene file must be a JSON object." };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.taskFamily !== "string") return { ok: false, reason: "Scene file needs a taskFamily string." };
  if (typeof record.seed !== "number" || !Number.isFinite(record.seed)) {
    return { ok: false, reason: "Scene file needs a numeric seed." };
  }
  const overrides = record.sceneOverrides;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    return { ok: false, reason: "Scene file needs sceneOverrides." };
  }
  const sceneOverrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: "Scene overrides must be finite numbers." };
    }
    sceneOverrides[key] = value;
  }
  const scene: ImportedSceneFile = { taskFamily: record.taskFamily, seed: record.seed, sceneOverrides };
  if (record.title !== undefined) {
    if (typeof record.title !== "string") return { ok: false, reason: "Scene title must be a string." };
    scene.title = record.title;
  }
  return { ok: true, value: scene };
}

export async function readImportedControllerFile(
  file: File,
): Promise<{ ok: true; source: string } | { ok: false; reason: string }> {
  if (!file.name.endsWith(".py")) return { ok: false, reason: "Controller file must end with .py." };
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, reason: "Controller file is larger than 64 KiB." };
  const source = await file.text();
  if (source.length === 0) return { ok: false, reason: "Controller file is empty." };
  return { ok: true, source };
}

export function combineImportedFailure(
  scene: ImportedSceneFile,
  controllerSource: string,
): { ok: true; value: ImportedFailure } | { ok: false; reason: string } {
  return validateImportedFailure({ ...scene, controllerSource });
}
