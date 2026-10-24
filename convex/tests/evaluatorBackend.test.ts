import { describe, expect, it } from "vitest";
import { evaluatorBackend, evaluatorSandboxEnv } from "../lib/evaluatorBackend.js";

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

  it("selects v3 for the signed-manifest snapshot", () => {
    expect(evaluatorBackend("forksafe-exec-v3")).toBe("v3");
  });

  it("injects the signing seed only into v3 evaluator sandboxes", () => {
    const env = { FORKSAFE_EVAL_SIGNING_KEY: `${"A".repeat(43)}=` };
    expect(evaluatorSandboxEnv("evaluator", "forksafe-exec-v3", env)).toEqual({ FORKSAFE_EVAL_SIGNING_KEY: `${"A".repeat(43)}=`, FORKSAFE_REQUIRE_SIGNING: "1" });
    expect(evaluatorSandboxEnv("execution", "forksafe-exec-v3", env)).toBeUndefined();
    expect(evaluatorSandboxEnv("runner", "forksafe-exec-v3", env)).toBeUndefined();
    expect(evaluatorSandboxEnv("evaluator", "forksafe-exec-v1", env)).toBeUndefined();
    expect(evaluatorSandboxEnv("evaluator", "forksafe-exec-v3", { FORKSAFE_EVAL_SIGNING_KEY: "not-a-key" })).toBeUndefined();
  });
});
