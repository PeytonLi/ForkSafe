import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  experimentIdentity,
  findingUseKey,
  partitionCandidates,
  partitionFindings,
  planBaselineRegister,
  planExperimentCommit,
  planFindingUse,
  validateGrantUse,
  sha256Hex,
  type BaselineInput,
} from "../../src/logic/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const investigationId = "22222222-2222-4222-8222-222222222222";
const environmentId = "33333333-3333-4333-8333-333333333333";
const otherEnvironmentId = "44444444-4444-4444-8444-444444444444";
const sha = "a".repeat(64);
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("pure hashing and canonical JSON", () => {
  it.each(["", "abc", "a".repeat(1_000), "é漢🙂"])("matches node SHA-256 for %s", (value) => {
    expect(sha256Hex(value)).toBe(digest(value));
  });

  it("sorts nested object keys while preserving array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: { y: 2, x: 1 } }))
      .toBe('{"a":{"x":1,"y":2},"z":[{"a":1,"b":2}]}');
    expect(canonicalJson({ outer: { left: 1, right: 2 } }))
      .toBe(canonicalJson({ outer: { right: 2, left: 1 } }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [undefined],
    [() => undefined],
    [1n],
  ])("rejects unsupported value %s", (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

const baselineRequirement: BaselineInput["requirements"][number] = {
  ruleId: "clearance",
  confluencePageId: "12345",
  confluencePageRevision: 3,
  title: "Minimum clearance",
  enforcement: "checked",
  ruleJson: '{"minimum":0.2}',
};

const baselineInput: BaselineInput = {
  id,
  simCase: {
    caseId: "case-1",
    suite: "regression",
    seed: 4,
    sceneOverridesJson: '{"size":2}',
  },
  sceneSha256: sha,
  controllerSha256: sha,
  assetsManifestSha256: sha,
  engineVersion: "3.3.0",
  failureKinds: ["stalled"],
  failureSummary: "The robot stalled at the turn.",
  sourceExperimentId: undefined,
  requirements: [baselineRequirement],
};

describe("baseline registration planning", () => {
  it("allows insert, identical replay, and rejects conflicting replacement", () => {
    const existing = {
      baseline: {
        id,
        simCase: baselineInput.simCase,
        sceneSha256: sha,
        controllerSha256: sha,
        assetsManifestSha256: sha,
        engineVersion: "3.3.0",
        failureKinds: ["stalled"],
        failureSummary: "The robot stalled at the turn.",
        sourceExperimentId: undefined,
      },
      requirements: [{ ...baselineRequirement, ordinal: 0 }],
    };
    expect(planBaselineRegister(undefined, baselineInput)).toEqual({ ok: true, noOp: false });
    expect(planBaselineRegister(existing, baselineInput)).toEqual({ ok: true, noOp: true });
    expect(planBaselineRegister(existing, { ...baselineInput, failureSummary: "Different" }))
      .toMatchObject({ code: "baseline_conflict" });
  });

  it("rejects malformed object JSON, hashes, page ids, duplicate rules, and oversized sets", () => {
    expect(planBaselineRegister(undefined, {
      ...baselineInput,
      simCase: { ...baselineInput.simCase, sceneOverridesJson: "[]" },
    })).toMatchObject({ code: "invalid_baseline" });
    expect(planBaselineRegister(undefined, { ...baselineInput, sceneSha256: "A".repeat(64) }))
      .toMatchObject({ code: "invalid_id" });
    expect(planBaselineRegister(undefined, {
      ...baselineInput,
      requirements: [{ ...baselineRequirement, confluencePageId: "12x" }],
    })).toMatchObject({ code: "invalid_baseline" });
    expect(planBaselineRegister(undefined, {
      ...baselineInput,
      requirements: [baselineRequirement, baselineRequirement],
    })).toMatchObject({ code: "invalid_baseline" });
    expect(planBaselineRegister(undefined, {
      ...baselineInput,
      requirements: Array.from({ length: 201 }, (_, ordinal) => ({
        ...baselineRequirement,
        ruleId: `rule-${ordinal}`,
      })),
    })).toMatchObject({ code: "invalid_baseline" });
  });
});

describe("experiment commit identity", () => {
  const identityInput = {
    controllerSha256: sha,
    suite: "regression",
    caseId: "case-1",
    seed: 12,
    sceneOverridesJson: '{"b":2,"a":{"d":4,"c":3}}',
    assetsSha256: "b".repeat(64),
    engineVersion: "3.3.0",
  };

  it("is deterministic and canonicalizes scene override object order", () => {
    expect(experimentIdentity(identityInput)).toBe(experimentIdentity(identityInput));
    expect(experimentIdentity(identityInput)).toBe(experimentIdentity({
      ...identityInput,
      sceneOverridesJson: '{"a":{"c":3,"d":4},"b":2}',
    }));
  });

  it.each([
    ["controllerSha256", "c".repeat(64)],
    ["suite", "other"],
    ["caseId", "other"],
    ["seed", 13],
    ["sceneOverridesJson", '{"different":true}'],
    ["assetsSha256", "d".repeat(64)],
    ["engineVersion", "3.4.0"],
  ])("changes identity when %s changes", (field, value) => {
    expect(experimentIdentity({ ...identityInput, [field]: value })).not.toBe(experimentIdentity(identityInput));
  });

  it("keeps evaluator and swarm identity scopes separate", () => {
    const canonical = {
      experimentId: id,
      investigationId,
      identityHash: sha,
      authorClass: "evaluator" as const,
      role: "canonical" as const,
      canonicalExperimentId: id,
    };
    expect(planExperimentCommit({
      canonicalForScope: canonical,
      input: { id: otherEnvironmentId, investigationId, authorClass: "swarm", identityHash: sha },
    })).toMatchObject({ ok: true, action: "insert_canonical" });
    expect(planExperimentCommit({
      canonicalForScope: canonical,
      input: { id: otherEnvironmentId, investigationId, authorClass: "evaluator", identityHash: sha },
    })).toMatchObject({ ok: true, action: "alias_duplicate", canonicalExperimentId: id });
  });

  it("handles retries, aliases, and replication mismatch adversarially", () => {
    expect(planExperimentCommit({
      existingExperimentSameId: { identical: true },
      input: { id, investigationId, authorClass: "swarm", identityHash: sha },
    })).toMatchObject({ ok: true, action: "noop" });
    expect(planExperimentCommit({
      existingIdentitySameId: { role: "duplicate", identityHash: sha },
      input: { id, investigationId, authorClass: "swarm", identityHash: sha },
    })).toMatchObject({ ok: true, action: "noop" });
    expect(planExperimentCommit({
      replicationTarget: { investigationId, authorClass: "evaluator", identityHash: sha },
      input: {
        id: otherEnvironmentId,
        investigationId,
        authorClass: "swarm",
        identityHash: sha,
        replicationOf: id,
        replicationReason: "independent confirmation",
      },
    })).toMatchObject({ code: "replication_mismatch" });
    expect(planExperimentCommit({
      input: {
        id,
        investigationId,
        authorClass: "swarm",
        identityHash: sha,
        replicationOf: id,
      },
    })).toMatchObject({ code: "invalid_replication" });
  });
});

describe("tombstone partitioning and finding-use planning", () => {
  const tombstones = new Map([
    ["finding:revoked", { reason: "privacy request", createdAtMs: 15 }],
    ["evidence:2", { reason: "evidence withdrawn", createdAtMs: 16 }],
    ["artifact:dead-artifact", { reason: "artifact withdrawn", createdAtMs: 17 }],
    ["candidate:revoked-candidate", { reason: "candidate withdrawn", createdAtMs: 18 }],
  ]);

  it("keeps only live evidence and surfaces tombstoned findings/candidates as revoked", () => {
    const findings = [
      { id: "live" },
      { id: "revoked" },
    ];
    const evidence = [
      { id: 1n, findingId: "live", artifactId: "ok" },
      { id: 2n, findingId: "live", artifactId: "ok" },
      { id: 3n, findingId: "live", artifactId: "dead-artifact" },
      { id: 4n, findingId: "revoked", artifactId: "ok" },
    ];
    expect(partitionFindings(findings, evidence, tombstones)).toEqual({
      live: [{ id: "live", evidence: [{ id: 1n, findingId: "live", artifactId: "ok" }] }],
      revoked: [{ findingId: "revoked", reason: "privacy request", tombstonedAtMs: 15 }],
    });
    expect(partitionCandidates([
      { id: "alive", sourceArtifactId: "ok" },
      { id: "dead-source", sourceArtifactId: "dead-artifact" },
      { id: "revoked-candidate", sourceArtifactId: "ok" },
    ], tombstones)).toMatchObject({
      live: [{ id: "alive", sourceArtifactId: "ok" }],
      revoked: [
        { candidateId: "dead-source", reason: "artifact withdrawn", tombstonedAtMs: 17 },
        { candidateId: "revoked-candidate", reason: "candidate withdrawn", tombstonedAtMs: 18 },
      ],
    });
  });

  const grant = {
    id,
    jobId: investigationId,
    attemptId: id,
    epoch: 1,
    investigationId,
    environmentId,
    operations: ["record_experiment"],
    artifactPrefixes: [],
    maxBytes: 100,
    bytesUsed: 0,
    expiresAtMs: 100,
  };
  const useInput = {
    id: otherEnvironmentId,
    findingId: id,
    experimentId: investigationId,
    grantId: grant.id,
    attemptId: grant.attemptId,
    epoch: grant.epoch,
  };
  const finding = { investigationId, environmentId: otherEnvironmentId };
  const experiment = { investigationId, environmentId };

  it("records cross-environment provenance and naturally deduplicates retries", () => {
    expect(findingUseKey(useInput)).toBe(`${id}:experiment:${investigationId}`);
    expect(planFindingUse({
      grant,
      finding,
      findingTombstoned: false,
      experiment,
      input: useInput,
    })).toEqual({ ok: true, noOp: false, crossEnvironment: true });
    expect(planFindingUse({
      grant,
      finding,
      findingTombstoned: false,
      experiment,
      existingSameKey: true,
      input: useInput,
    })).toEqual({ ok: true, noOp: true, crossEnvironment: true });
  });

  it("rejects evaluator scope, foreign investigation/environment, tombstones, and malformed uses", () => {
    expect(planFindingUse({
      grant: { ...grant, environmentId: undefined },
      finding,
      findingTombstoned: false,
      experiment,
      input: useInput,
    })).toMatchObject({ code: "scope_mismatch" });
    expect(planFindingUse({
      grant,
      finding: { ...finding, investigationId: otherEnvironmentId },
      findingTombstoned: false,
      experiment,
      input: useInput,
    })).toMatchObject({ code: "scope_mismatch" });
    expect(planFindingUse({
      grant,
      finding,
      findingTombstoned: true,
      experiment,
      input: useInput,
    })).toMatchObject({ code: "finding_tombstoned" });
    expect(planFindingUse({
      grant,
      finding,
      findingTombstoned: false,
      experiment: { ...experiment, environmentId: otherEnvironmentId },
      input: useInput,
    })).toMatchObject({ code: "scope_mismatch" });
    expect(planFindingUse({
      grant,
      finding,
      findingTombstoned: false,
      experiment,
      input: { ...useInput, candidateId: id },
    })).toMatchObject({ code: "invalid_finding_use" });
  });

  it("fences finding-use grant operations against stale epochs, attempts, and supersession", () => {
    const ref = { grantId: grant.id, attemptId: grant.attemptId, epoch: grant.epoch };
    const fence = { jobId: grant.jobId, epoch: grant.epoch, grantId: grant.id };
    expect(validateGrantUse(grant, fence, ref, "record_experiment", 0, "identity"))
      .toMatchObject({ ok: true });
    expect(validateGrantUse(grant, fence, { ...ref, attemptId: otherEnvironmentId }, "record_experiment", 0, "identity"))
      .toMatchObject({ code: "stale_attempt" });
    expect(validateGrantUse(grant, { ...fence, epoch: grant.epoch + 1 }, ref, "record_experiment", 0, "identity"))
      .toMatchObject({ code: "stale_epoch" });
    expect(validateGrantUse({
      ...grant,
      revokedAtMs: 1,
      revokeReason: "superseded",
    }, fence, ref, "record_experiment", 0, "identity"))
      .toMatchObject({ code: "grant_superseded" });
  });
});
