import { describe, expect, it } from "vitest";
import { challengesFor, saveChallenge, type ChallengeRequest } from "./challengeCase";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function request(overrides: Partial<ChallengeRequest> = {}): ChallengeRequest {
  return {
    id: "case-1",
    investigationId: "inv-1",
    candidateId: "cand-1",
    caseId: "challenge-10",
    seed: 3,
    sceneOverrides: { dividerDx: -0.02 },
    note: "Move the divider closer.",
    status: "pending_physics",
    createdAtMs: 10,
    ...overrides,
  };
}

describe("challenge cases", () => {
  it("stores a pending case for one investigation", () => {
    const storage = new MemoryStorage();
    saveChallenge(request(), storage);
    saveChallenge(request({ id: "case-2", investigationId: "inv-2", note: "Other" }), storage);
    expect(challengesFor("inv-1", storage)).toEqual([request()]);
    expect(challengesFor("inv-2", storage).map((item) => item.id)).toEqual(["case-2"]);
    expect(storage.getItem("forksafe.challenges.inv-1")).toContain("pending_physics");
  });

  it("caps the note, drops non-finite overrides, and generates a missing id", () => {
    const storage = new MemoryStorage();
    saveChallenge(request({
      id: "",
      note: "n".repeat(300),
      sceneOverrides: { dividerDx: -0.02, speedScale: Number.POSITIVE_INFINITY, cubeDx: Number.NaN, gapWidth: 0.08 },
    }), storage);
    const [stored] = challengesFor("inv-1", storage);
    expect(stored?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(stored?.note).toHaveLength(280);
    expect(stored?.sceneOverrides).toEqual({ dividerDx: -0.02, gapWidth: 0.08 });
    expect(stored?.status).toBe("pending_physics");
  });

  it("does not surface a stored pass or fail, or corrupt JSON", () => {
    const storage = new MemoryStorage();
    storage.setItem("forksafe.challenges.inv-1", JSON.stringify([{ ...request(), status: "passed" }]));
    expect(challengesFor("inv-1", storage)).toEqual([]);
    storage.setItem("forksafe.challenges.inv-1", "{");
    expect(challengesFor("inv-1", storage)).toEqual([]);
    storage.setItem("forksafe.challenges.inv-1", JSON.stringify({ note: "not a list" }));
    expect(challengesFor("inv-1", storage)).toEqual([]);
  });
});
