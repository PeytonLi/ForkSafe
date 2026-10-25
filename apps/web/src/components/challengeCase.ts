export interface ChallengeRequest {
  id: string;
  investigationId: string;
  candidateId: string;
  caseId: string;
  seed: number;
  sceneOverrides: Record<string, number>;
  note: string;
  status: "pending_physics";
  createdAtMs: number;
}

function storageKey(investigationId: string): string {
  return `forksafe.challenges.${investigationId}`;
}

function finiteOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) next[key] = entry;
  }
  return next;
}

function readChallenge(value: unknown): ChallengeRequest | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.status !== "pending_physics") return null;
  if (typeof row.id !== "string" || row.id.trim() === "") return null;
  if (typeof row.investigationId !== "string" || typeof row.candidateId !== "string" || typeof row.caseId !== "string") return null;
  if (typeof row.seed !== "number" || !Number.isFinite(row.seed)) return null;
  if (typeof row.note !== "string") return null;
  if (typeof row.createdAtMs !== "number" || !Number.isFinite(row.createdAtMs)) return null;
  return {
    id: row.id,
    investigationId: row.investigationId,
    candidateId: row.candidateId,
    caseId: row.caseId,
    seed: row.seed,
    sceneOverrides: finiteOverrides(row.sceneOverrides),
    note: row.note.slice(0, 280),
    status: "pending_physics",
    createdAtMs: row.createdAtMs,
  };
}

function browserStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  const store = globalThis.localStorage;
  return store && typeof store.getItem === "function" ? store : null;
}

export function challengesFor(investigationId: string, storage?: Storage): ChallengeRequest[] {
  const store = browserStorage(storage);
  if (!store) return [];
  const raw = store.getItem(storageKey(investigationId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const row = readChallenge(item);
      return row ? [row] : [];
    });
  } catch {
    return [];
  }
}

export function saveChallenge(request: ChallengeRequest, storage?: Storage): void {
  if (!Number.isFinite(request.seed)) return;
  const store = browserStorage(storage);
  if (!store) return;
  const createdAtMs = Number.isFinite(request.createdAtMs) ? request.createdAtMs : Date.now();
  const stored: ChallengeRequest = {
    id: request.id.trim() ? request.id : crypto.randomUUID(),
    investigationId: request.investigationId,
    candidateId: request.candidateId,
    caseId: request.caseId || `challenge-${createdAtMs}`,
    seed: request.seed,
    sceneOverrides: finiteOverrides(request.sceneOverrides),
    note: (request.note ?? "").slice(0, 280),
    status: "pending_physics",
    createdAtMs,
  };
  const existing = challengesFor(stored.investigationId, store).filter((item) => item.id !== stored.id);
  store.setItem(storageKey(stored.investigationId), JSON.stringify([...existing, stored]));
}

export function removeChallenge(investigationId: string, id: string, storage?: Storage): void {
  const store = browserStorage(storage);
  if (!store) return;
  const existing = challengesFor(investigationId, store).filter((item) => item.id !== id);
  store.setItem(storageKey(investigationId), JSON.stringify(existing));
}
