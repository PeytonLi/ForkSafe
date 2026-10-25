export interface ReplaySeek {
  investigationId: string;
  tSec: number;
  citationId: string;
}

const KEY = "forksafe.replaySeek";

type SeekStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const listeners = new Map<string, Set<(seek: ReplaySeek) => void>>();
let memory: ReplaySeek | null = null;
let storageOverride: SeekStorage | undefined;
const memoryStore = new Map<string, string>();

const fallbackStorage: SeekStorage = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => { memoryStore.set(key, value); },
  removeItem: (key) => { memoryStore.delete(key); },
};

function store(): SeekStorage {
  if (storageOverride) return storageOverride;
  if (typeof sessionStorage !== "undefined") return sessionStorage;
  return fallbackStorage;
}

/** Tests pass a storage double. Production uses sessionStorage when the page has one. */
export function setReplaySeekStorage(next: SeekStorage | null): void {
  storageOverride = next ?? undefined;
  memory = null;
  listeners.clear();
}

/** Clears listeners and the stored seek. Tests call this between cases. */
export function resetReplaySeek(): void {
  listeners.clear();
  memory = null;
  try { store().removeItem(KEY); } catch { /* storage disabled */ }
  storageOverride = undefined;
  memoryStore.clear();
}

function acceptable(tSec: number): boolean {
  return Number.isFinite(tSec) && tSec >= 0;
}

function parseSeek(raw: string | null): ReplaySeek | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const seek = value as { investigationId?: unknown; tSec?: unknown; citationId?: unknown };
    if (typeof seek.investigationId !== "string" || typeof seek.citationId !== "string" || typeof seek.tSec !== "number") return null;
    if (!acceptable(seek.tSec)) return null;
    return { investigationId: seek.investigationId, tSec: seek.tSec, citationId: seek.citationId };
  } catch {
    return null;
  }
}

function readStored(): ReplaySeek | null {
  try {
    return parseSeek(store().getItem(KEY));
  } catch {
    return null;
  }
}

export function requestReplaySeek(seek: ReplaySeek): void {
  if (!acceptable(seek.tSec)) return;
  const next: ReplaySeek = { investigationId: seek.investigationId, tSec: seek.tSec, citationId: seek.citationId };
  memory = next;
  try {
    store().setItem(KEY, JSON.stringify(next));
  } catch { /* persistence is best-effort; same-tab listeners still run */ }
  const subs = listeners.get(next.investigationId);
  if (subs) for (const onSeek of subs) onSeek(next);
}

export function readReplaySeek(investigationId: string): ReplaySeek | null {
  if (memory?.investigationId === investigationId) return memory;
  const stored = readStored();
  if (!stored || stored.investigationId !== investigationId) return null;
  memory = stored;
  return stored;
}

export function subscribeReplaySeek(investigationId: string, onSeek: (seek: ReplaySeek) => void): () => void {
  let subs = listeners.get(investigationId);
  if (!subs) {
    subs = new Set();
    listeners.set(investigationId, subs);
  }
  subs.add(onSeek);
  return () => {
    subs.delete(onSeek);
    if (subs.size === 0) listeners.delete(investigationId);
  };
}
