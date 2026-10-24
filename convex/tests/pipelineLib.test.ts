import { describe, expect, it } from "vitest";
import { changedFunctions, unifiedDiff } from "../lib/controllerDiff.js";
import { classifyExperiment, caseStatus, compactReplay, rankCandidates } from "../lib/experimentStatus.js";
import { hmacSha256Hex, verifyRunnerSignature } from "../lib/runnerAuth.js";
import { encodeReducerArgs, option } from "../lib/spacetime.js";

describe("runner credential signatures", () => {
  const credential = { secret: "s3cret", expiresAtMs: 10_000 };
  it("accepts a fresh, correctly signed request", async () => {
    const signature = await hmacSha256Hex("s3cret", `5000.{"a":1}`);
    const verdict = await verifyRunnerSignature(credential, { credentialId: "c", timestamp: "5000", signature }, '{"a":1}', 5_100);
    expect(verdict).toEqual({ ok: true });
  });
  it("fails closed on missing headers, unknown/expired/revoked credentials, skew and bad signatures", async () => {
    const signature = await hmacSha256Hex("s3cret", `5000.{}`);
    expect((await verifyRunnerSignature(credential, { credentialId: null, timestamp: "5000", signature }, "{}", 5_000)).ok).toBe(false);
    expect((await verifyRunnerSignature(null, { credentialId: "c", timestamp: "5000", signature }, "{}", 5_000))).toMatchObject({ reason: "unknown_credential" });
    expect((await verifyRunnerSignature(credential, { credentialId: "c", timestamp: "5000", signature }, "{}", 10_001))).toMatchObject({ reason: "credential_expired" });
    expect((await verifyRunnerSignature({ ...credential, revokedAtMs: 1 }, { credentialId: "c", timestamp: "5000", signature }, "{}", 5_000))).toMatchObject({ reason: "credential_revoked" });
    expect((await verifyRunnerSignature({ ...credential, expiresAtMs: 200_000 }, { credentialId: "c", timestamp: "5000", signature }, "{}", 70_001))).toMatchObject({ reason: "timestamp_skew" });
    expect((await verifyRunnerSignature(credential, { credentialId: "c", timestamp: "5000", signature }, "{} ", 5_000))).toMatchObject({ reason: "bad_signature" });
  });
});

describe("spacetime reducer encoding", () => {
  it("keeps top-level argument names and snake_cases nested product fields", () => {
    expect(encodeReducerArgs({ jobId: "j", grant: { grantId: "g", attemptId: "a", epoch: 1 }, environmentId: option("e"), none: option(undefined) }))
      .toEqual({ jobId: "j", grant: { grant_id: "g", attempt_id: "a", epoch: 1 }, environmentId: { some: "e" }, none: null });
  });
});

describe("controller diff", () => {
  const base = "import math\n\ndef plan(scene):\n    return [1]\n\ndef helper(x):\n    return x\n";
  it("detects changed functions and module body", () => {
    expect(changedFunctions(base, base.replace("return [1]", "return [2]"))).toEqual(["plan"]);
    expect(changedFunctions(base, base.replace("import math", "import math\nK = 2"))).toEqual(["<module>"]);
    expect(changedFunctions(base, base)).toEqual([]);
  });
  it("produces a unified diff with hunks", () => {
    const diff = unifiedDiff(base, base.replace("return [1]", "return [2]"));
    expect(diff).toContain("-    return [1]");
    expect(diff).toContain("+    return [2]");
    expect(unifiedDiff(base, base)).toBe("");
  });
});

describe("experiment status", () => {
  it("classifies measured outcomes", () => {
    expect(classifyExperiment({ completed: true, failureKinds: [] })).toBe("succeeded");
    expect(classifyExperiment({ completed: false, failureKinds: ["forbidden_contact"] })).toBe("constraint_violation");
    expect(classifyExperiment({ completed: false, failureKinds: ["timeout"] })).toBe("physics_failure");
    expect(classifyExperiment({ completed: true, failureKinds: ["missing_artifact"] })).toBe("invalid");
    expect(caseStatus({ completed: true, failureKinds: [], controllerSha256: "a" }, "b")).toBe("invalid");
  });
  it("ranks passing, smaller, faster candidates first", () => {
    const ranked = rankCandidates([
      { id: "c", allPassed: true, changedFunctions: 2, medianCompletionTimeSec: 1 },
      { id: "a", allPassed: false, changedFunctions: 1, medianCompletionTimeSec: 1 },
      { id: "b", allPassed: true, changedFunctions: 1, medianCompletionTimeSec: 5 },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["b", "c", "a"]);
  });
  it("compacts replay frames without dropping the last frame", () => {
    const frames = Array.from({ length: 4000 }, (_, i) => ({ t: i, qpos: [1, 2, 3, 4, 5, 6, 7, 8, 9], qvel: [1, 2], ctrl: [1] }));
    const compact = compactReplay({ frames }, 50_000);
    expect(compact.truncated).toBe(true);
    const kept = compact.result.frames as { t: number }[];
    expect(kept.at(-1)!.t).toBe(3999);
    expect(JSON.stringify(compact.result).length).toBeLessThanOrEqual(50_000);
  });
});
