import { describe, expect, it } from "vitest";
import { evaluatorBackend } from "../lib/evaluatorBackend.js";

describe("evaluatorBackend", () => {
  it("uses v1 for existing snapshots", () => {
    expect(evaluatorBackend(undefined)).toBe("v1");
    expect(evaluatorBackend("forksafe-exec-v1")).toBe("v1");
  });

  it("selects v2 only for the v2 snapshot prefix", () => {
    expect(evaluatorBackend("forksafe-exec-v2")).toBe("v2");
    expect(evaluatorBackend("forksafe-exec-v2-2026-06")).toBe("v2");
    expect(evaluatorBackend("other-forksafe-exec-v2")).toBe("v1");
  });
});
