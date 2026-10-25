import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReplaySeek, requestReplaySeek, resetReplaySeek, setReplaySeekStorage, subscribeReplaySeek, type ReplaySeek } from "./replaySeek";

const INV = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";
const OTHER = "9e9efe34-0000-4000-8000-000000000000";

function mockStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

describe("replay seek", () => {
  let storage: ReturnType<typeof mockStorage>;

  beforeEach(() => {
    storage = mockStorage();
    setReplaySeekStorage(storage);
  });

  afterEach(() => resetReplaySeek());

  it("keeps the latest seek in storage so a later read survives a dropped in-memory copy", () => {
    requestReplaySeek({ investigationId: INV, tSec: 1.2, citationId: "a" });
    requestReplaySeek({ investigationId: INV, tSec: 1.8, citationId: "b" });
    setReplaySeekStorage(storage);
    expect(readReplaySeek(INV)).toEqual({ investigationId: INV, tSec: 1.8, citationId: "b" });
    expect(JSON.parse(storage.getItem("forksafe.replaySeek")!)).toEqual({ investigationId: INV, tSec: 1.8, citationId: "b" });
  });

  it("ignores non-finite and negative times and still accepts zero", () => {
    requestReplaySeek({ investigationId: INV, tSec: 1.8, citationId: "a" });
    requestReplaySeek({ investigationId: INV, tSec: Number.NaN, citationId: "b" });
    requestReplaySeek({ investigationId: INV, tSec: Number.POSITIVE_INFINITY, citationId: "c" });
    requestReplaySeek({ investigationId: INV, tSec: -0.1, citationId: "d" });
    expect(readReplaySeek(INV)).toEqual({ investigationId: INV, tSec: 1.8, citationId: "a" });
    requestReplaySeek({ investigationId: INV, tSec: 0, citationId: "zero" });
    expect(readReplaySeek(INV)?.tSec).toBe(0);
  });

  it("notifies the matching investigation until unsubscribe and ignores a corrupt record", () => {
    const seen: ReplaySeek[] = [];
    const stop = subscribeReplaySeek(INV, (seek) => seen.push(seek));
    requestReplaySeek({ investigationId: OTHER, tSec: 3, citationId: "other" });
    requestReplaySeek({ investigationId: INV, tSec: 1.8, citationId: "mine" });
    stop();
    requestReplaySeek({ investigationId: INV, tSec: 2, citationId: "later" });
    expect(seen).toEqual([{ investigationId: INV, tSec: 1.8, citationId: "mine" }]);
    expect(readReplaySeek(OTHER)).toBeNull();
    expect(readReplaySeek(INV)?.citationId).toBe("later");
    storage.setItem("forksafe.replaySeek", "{");
    setReplaySeekStorage(storage);
    expect(readReplaySeek(INV)).toBeNull();
  });
});
