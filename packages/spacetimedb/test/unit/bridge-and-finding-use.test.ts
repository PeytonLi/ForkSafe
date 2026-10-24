import { describe, expect, it } from "vitest";
import { planBridgeRotation, validateFindingUse, type FindingUseCheck } from "../../src/logic/index.js";

describe("bridge identity rotation", () => {
  it("revokes every other convex identity and keeps the caller and non-convex roles", () => {
    const rows = [
      { identityHex: "aa", role: "convex" },
      { identityHex: "bb", role: "convex" },
      { identityHex: "cc", role: "operator" },
      { identityHex: "dd", role: "convex" },
    ];
    expect(planBridgeRotation(rows, "bb")).toEqual({ revokeHex: ["aa", "dd"] });
  });

  it("revokes all 16 stale convex rows when a fresh identity rotates in", () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({ identityHex: `stale${index}`, role: "convex" }));
    expect(planBridgeRotation(rows, "fresh").revokeHex).toHaveLength(16);
  });
});

describe("finding use validation", () => {
  const base: FindingUseCheck = {
    grant: { investigationId: "inv", environmentId: "envB" },
    finding: { investigationId: "inv", environmentId: "envA" },
    findingTombstoned: false,
    targetCount: 1,
    target: { investigationId: "inv", environmentId: "envB" },
    requested: { findingId: "f1", candidateId: "c1" },
  };

  it("accepts a cross-environment use and reports duplicates idempotently", () => {
    expect(validateFindingUse(base)).toEqual({ ok: true, duplicate: false });
    expect(validateFindingUse({ ...base, existing: { findingId: "f1", candidateId: "c1" } })).toEqual({ ok: true, duplicate: true });
  });

  it.each([
    ["finding_use_target_invalid", { targetCount: 2 }],
    ["finding_use_target_invalid", { targetCount: 0 }],
    ["finding_missing", { finding: undefined }],
    ["finding_tombstoned", { findingTombstoned: true }],
    ["target_missing", { target: undefined }],
    ["scope_mismatch", { finding: { investigationId: "other", environmentId: "envA" } }],
    ["scope_mismatch", { target: { investigationId: "inv", environmentId: "envC" } }],
    ["finding_use_same_environment", { finding: { investigationId: "inv", environmentId: "envB" } }],
    ["finding_use_conflict", { existing: { findingId: "f2", candidateId: "c1" } }],
  ] as const)("rejects %s", (code, patch) => {
    expect(validateFindingUse({ ...base, ...patch } as FindingUseCheck)).toMatchObject({ ok: false, code });
  });
});
