import {
  ArtifactKind,
  CandidateStatus,
  EvaluationStatus,
  EvidenceKind,
  ExperimentStatus,
  FailureKind,
  FindingKind,
  OutboxDestination,
  OutboxStatus,
  ReviewDecision,
} from "@forksafe/contracts";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_KINDS,
  CANDIDATE_STATUSES,
  EVALUATION_STATUSES,
  EVIDENCE_KINDS,
  EXPERIMENT_STATUSES,
  FAILURE_KINDS,
  FINDING_KINDS,
  GRANT_OPS,
  OUTBOX_DESTINATIONS,
  OUTBOX_STATUSES,
  REVIEW_DECISIONS,
  checkArtifactScope,
  checkExpectedHead,
  checkScope,
  deriveCandidateStatus,
  planEvaluationWrite,
  planGrantInstall,
  planLeaseAcquire,
  planLeaseRenew,
  planOutboxEnqueue,
  planOutboxFailure,
  secretsMatch,
  validateGrantUse,
} from "../../src/logic/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const sha = "a".repeat(64);
const ref = { grantId: id, attemptId: otherId, epoch: 2 };
const grant = {
  id,
  jobId: otherId,
  attemptId: otherId,
  epoch: 2,
  investigationId: "33333333-3333-4333-8333-333333333333",
  environmentId: "44444444-4444-4444-8444-444444444444",
  operations: ["record_artifact"],
  artifactPrefixes: ["inv/example/"],
  maxBytes: 100,
  bytesUsed: 10,
  expiresAtMs: 200,
};
const fence = { jobId: grant.jobId, epoch: grant.epoch, grantId: grant.id };

describe("grant validation", () => {
  it("accepts a live grant and binds its first sender", () => {
    expect(validateGrantUse(grant, fence, ref, "record_artifact", 199, "identity")).toEqual({
      ok: true,
      bindHolder: true,
    });
  });

  it("checks existence, revocation, and expiry at the boundary", () => {
    expect(validateGrantUse(undefined, fence, ref, "heartbeat", 0, "x")).toMatchObject({
      code: "grant_not_found",
    });
    expect(validateGrantUse({ ...grant, revokedAtMs: 1 }, fence, ref, "heartbeat", 0, "x")).toMatchObject({
      code: "grant_revoked",
    });
    expect(
      validateGrantUse(
        { ...grant, revokedAtMs: 1, revokeReason: "superseded" },
        fence,
        ref,
        "heartbeat",
        0,
        "x",
      ),
    ).toMatchObject({ code: "grant_superseded" });
    expect(validateGrantUse(grant, fence, ref, "heartbeat", grant.expiresAtMs, "x")).toMatchObject({
      code: "grant_expired",
    });
  });

  it("rejects stale attempts and epochs before checking the operation", () => {
    expect(
      validateGrantUse(grant, fence, { ...ref, attemptId: id }, "not_allowed", 100, "x"),
    ).toMatchObject({ code: "stale_attempt" });
    expect(
      validateGrantUse(grant, { ...fence, epoch: 3 }, ref, "record_artifact", 100, "x"),
    ).toMatchObject({ code: "stale_epoch" });
    expect(
      validateGrantUse(grant, undefined, ref, "record_artifact", 100, "x"),
    ).toMatchObject({ code: "stale_epoch" });
  });

  it("limits operations except heartbeat and rejects a bound identity mismatch", () => {
    expect(validateGrantUse(grant, fence, ref, "commit_revision", 100, "x")).toMatchObject({
      code: "op_not_allowed",
    });
    expect(validateGrantUse(grant, fence, ref, "heartbeat", 100, "x")).toMatchObject({
      ok: true,
      bindHolder: true,
    });
    expect(
      validateGrantUse({ ...grant, holder: "other" }, fence, ref, "record_artifact", 100, "x"),
    ).toMatchObject({ code: "holder_mismatch" });
    expect(
      validateGrantUse({ ...grant, holder: "identity" }, fence, ref, "record_artifact", 100, "identity"),
    ).toMatchObject({ ok: true, bindHolder: false });
  });

  it("enforces investigation and optional environment scope", () => {
    expect(checkScope(grant, { investigationId: grant.investigationId, environmentId: grant.environmentId })).toEqual({
      ok: true,
    });
    expect(checkScope(grant, { investigationId: id })).toMatchObject({ code: "scope_mismatch" });
    expect(checkScope(grant, { environmentId: id })).toMatchObject({ code: "scope_mismatch" });
    expect(checkScope({ ...grant, environmentId: undefined }, { environmentId: id })).toEqual({ ok: true });
  });
});

describe("grant installation planning", () => {
  const input = {
    id,
    jobId: otherId,
    attemptId: "55555555-5555-4555-8555-555555555555",
    epoch: 3,
    investigationId: "33333333-3333-4333-8333-333333333333",
    environmentId: grant.environmentId,
    operations: ["heartbeat", "record_artifact"],
    artifactPrefixes: ["inv/example/"],
    maxBytes: 500,
    expiresAtMs: 500,
  };
  const sameGrant = {
    ...input,
    bytesUsed: 0,
    expiresAtMs: input.expiresAtMs,
  };

  it("is idempotent for identical grants and rejects id conflicts", () => {
    expect(planGrantInstall(sameGrant, undefined, input, 100)).toMatchObject({
      ok: true,
      noOp: true,
    });
    expect(planGrantInstall({ ...sameGrant, maxBytes: 1 }, undefined, input, 100)).toMatchObject({
      code: "grant_conflict",
    });
  });

  it("rejects expired, invalid-scope, invalid-id, and stale-epoch installs", () => {
    expect(planGrantInstall(undefined, undefined, { ...input, expiresAtMs: 100 }, 100)).toMatchObject({
      code: "grant_expired",
    });
    expect(
      planGrantInstall(undefined, undefined, { ...input, operations: ["admin"] }, 100),
    ).toMatchObject({ code: "invalid_scope" });
    expect(planGrantInstall(undefined, undefined, { ...input, id: "bad" }, 100)).toMatchObject({
      code: "invalid_id",
    });
    expect(
      planGrantInstall(undefined, { ...fence, epoch: input.epoch }, input, 100),
    ).toMatchObject({ code: "stale_epoch" });
  });

  it("plans revocation of every other active job grant", () => {
    expect(
      planGrantInstall(
        undefined,
        undefined,
        input,
        100,
        [
          { ...grant, id: otherId, revokedAtMs: undefined },
          { ...grant, id: id, revokedAtMs: undefined },
          { ...grant, id: "66666666-6666-4666-8666-666666666666", revokedAtMs: 1 },
        ],
      ),
    ).toMatchObject({ ok: true, noOp: false, supersededIds: [otherId] });
  });
});

describe("revision leases and optimistic heads", () => {
  const lease = {
    environmentId: grant.environmentId!,
    holderAttemptId: grant.attemptId,
    grantId: grant.id,
    epoch: grant.epoch,
    acquiredAtMs: 100,
    renewedAtMs: 100,
    expiresAtMs: 200,
  };
  const leaseGrant = {
    attemptId: grant.attemptId,
    id: grant.id,
    epoch: grant.epoch,
    expiresAtMs: 150,
  };

  it("acquires free/expired leases, renews same holders, and caps expiry", () => {
    expect(planLeaseAcquire(undefined, leaseGrant, lease.environmentId, 100)).toMatchObject({
      ok: true,
      lease: { acquiredAtMs: 100, renewedAtMs: 100, expiresAtMs: 150 },
    });
    expect(
      planLeaseAcquire({ ...lease, expiresAtMs: 99 }, { ...leaseGrant, attemptId: id }, lease.environmentId, 100),
    ).toMatchObject({ ok: true, lease: { expiresAtMs: 150 } });
    expect(planLeaseAcquire(lease, { ...leaseGrant, expiresAtMs: 50 }, lease.environmentId, 100)).toMatchObject({
      ok: true,
      lease: { expiresAtMs: 50 },
    });
    expect(planLeaseAcquire(lease, { ...leaseGrant, attemptId: id }, lease.environmentId, 100)).toMatchObject({
      code: "lease_held",
    });
  });

  it("renews only a live lease held by the grant attempt", () => {
    expect(planLeaseRenew(undefined, leaseGrant, 110)).toMatchObject({ code: "lease_missing" });
    expect(planLeaseRenew(lease, { ...leaseGrant, attemptId: id }, 110)).toMatchObject({
      code: "lease_held",
    });
    expect(planLeaseRenew({ ...lease, expiresAtMs: 110 }, leaseGrant, 110)).toMatchObject({
      code: "lease_expired",
    });
    expect(planLeaseRenew(lease, leaseGrant, 110)).toMatchObject({
      ok: true,
      lease: { renewedAtMs: 110, expiresAtMs: 150 },
    });
  });

  it("checks all expected-head branches", () => {
    expect(checkExpectedHead(undefined, undefined)).toEqual({ ok: true });
    expect(checkExpectedHead(undefined, id)).toMatchObject({ code: "revision_conflict" });
    expect(checkExpectedHead({ environmentId: id, headRevisionId: otherId, seq: 1 }, otherId)).toEqual({
      ok: true,
    });
    expect(
      checkExpectedHead({ environmentId: id, headRevisionId: otherId, seq: 1 }, undefined),
    ).toMatchObject({ code: "revision_conflict" });
  });
});

describe("artifact scope, outbox, evaluation, and candidate state", () => {
  it("enforces artifact prefix, path traversal, and byte budget", () => {
    const scope = { artifactPrefixes: ["inv/"], bytesUsed: 8, maxBytes: 10 };
    expect(checkArtifactScope(scope, "inv/a", 2)).toEqual({ ok: true });
    expect(checkArtifactScope(scope, "other/a", 1)).toMatchObject({ code: "artifact_scope" });
    expect(checkArtifactScope(scope, "inv/../a", 1)).toMatchObject({ code: "artifact_scope" });
    expect(checkArtifactScope(scope, "inv/a", 3)).toMatchObject({ code: "artifact_too_large" });
  });

  it("deduplicates outbox entries and rejects idempotency conflicts", () => {
    const input = {
      id: id,
      destination: "elastic_index",
      idempotencyKey: "finding:1:index",
      operationId: otherId,
      payloadJson: '{"id":"1"}',
      sourceKind: "finding",
      sourceId: id,
    };
    expect(planOutboxEnqueue(undefined, input)).toEqual({ ok: true, noOp: false });
    expect(
      planOutboxEnqueue(
        {
          ...input,
          status: "pending",
          attempts: 0,
          createdAtMs: 1,
        },
        input,
      ),
    ).toEqual({ ok: true, noOp: true });
    expect(
      planOutboxEnqueue(
        {
          ...input,
          status: "pending",
          attempts: 0,
          createdAtMs: 1,
        },
        { ...input, payloadJson: "{}" },
      ),
    ).toMatchObject({ code: "idempotency_conflict" });
    expect(planOutboxEnqueue(undefined, { ...input, idempotencyKey: "short" })).toMatchObject({
      code: "invalid_idempotency_key",
    });
    expect(planOutboxFailure({ status: "pending", attempts: 6 })).toEqual({
      status: "pending",
      attempts: 7,
    });
    expect(planOutboxFailure({ status: "pending", attempts: 7 })).toEqual({
      status: "dead",
      attempts: 8,
    });
  });

  it("guards evaluation updates and derives all candidate states", () => {
    const activeEvaluation = {
      id,
      candidateId: otherId,
      evaluatorAttemptId: id,
      status: "running",
    };
    expect(planEvaluationWrite(undefined, activeEvaluation, id)).toEqual({
      ok: true,
      action: "insert",
    });
    expect(planEvaluationWrite(activeEvaluation, { ...activeEvaluation, status: "queued" }, id)).toEqual({
      ok: true,
      action: "update",
    });
    expect(
      planEvaluationWrite({ ...activeEvaluation, evaluatorAttemptId: otherId }, activeEvaluation, id),
    ).toMatchObject({ code: "stale_attempt" });
    expect(
      planEvaluationWrite({ ...activeEvaluation, status: "passed" }, activeEvaluation, id),
    ).toMatchObject({ code: "evaluation_final" });

    expect(deriveCandidateStatus({ tombstoned: true, evaluations: [], reviews: [] })).toBe("withdrawn");
    expect(
      deriveCandidateStatus({ tombstoned: false, evaluations: [], reviews: [{ decision: "rejected" }] }),
    ).toBe("rejected");
    expect(
      deriveCandidateStatus({ tombstoned: false, evaluations: [{ status: "failed" }], reviews: [] }),
    ).toBe("evaluated");
    expect(
      deriveCandidateStatus({ tombstoned: false, evaluations: [{ status: "running" }], reviews: [] }),
    ).toBe("evaluating");
    expect(deriveCandidateStatus({ tombstoned: false, evaluations: [], reviews: [] })).toBe("submitted");
  });
});

describe("contract parity and shared helpers", () => {
  it("mirrors each contract enum exactly", () => {
    expect(FINDING_KINDS).toEqual(FindingKind.options);
    expect(EVIDENCE_KINDS).toEqual(EvidenceKind.options);
    expect(CANDIDATE_STATUSES).toEqual(CandidateStatus.options);
    expect(EVALUATION_STATUSES).toEqual(EvaluationStatus.options);
    expect(REVIEW_DECISIONS).toEqual(ReviewDecision.options);
    expect(ARTIFACT_KINDS).toEqual(ArtifactKind.options);
    expect(OUTBOX_STATUSES).toEqual(OutboxStatus.options);
    expect(OUTBOX_DESTINATIONS).toEqual(OutboxDestination.options);
    expect(EXPERIMENT_STATUSES).toEqual(ExperimentStatus.options);
    expect(FAILURE_KINDS).toEqual(FailureKind.options);
    expect(GRANT_OPS).toEqual([
      "heartbeat",
      "acquire_revision_lease",
      "renew_revision_lease",
      "release_revision_lease",
      "commit_revision",
      "record_artifact",
      "record_experiment",
      "record_finding",
      "submit_candidate",
      "record_evaluation",
      "outbox_enqueue",
    ]);
  });

  it("uses constant-time-ish secret comparison with a length check", () => {
    expect(secretsMatch("secret", "secret")).toBe(true);
    expect(secretsMatch("secret", "secreT")).toBe(false);
    expect(secretsMatch("secret", "secret!")).toBe(false);
  });
});
