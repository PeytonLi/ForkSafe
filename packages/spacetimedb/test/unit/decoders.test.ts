import { describe, expect, it } from "vitest";
import {
  decodeArtifact,
  decodeCandidate,
  decodeEvaluation,
  decodeExperiment,
  decodeFinding,
  decodeLiveCandidates,
  decodeLiveFindings,
  decodeGrant,
  decodeOutbox,
  decodeReview,
  decodeRevisionLease,
} from "../../client/decoders.js";

const investigationId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const candidateId = "55555555-5555-4555-8555-555555555555";
const evaluationId = "66666666-6666-4666-8666-666666666666";
const findingId = "77777777-7777-4777-8777-777777777777";
const sha256 = "a".repeat(64);

describe("contract entity decoders", () => {
  it("converts grants and revision leases to contract rows", () => {
    expect(
      decodeGrant({
        id: "88888888-8888-4888-8888-888888888888",
        jobId: "99999999-9999-4999-8999-999999999999",
        attemptId,
        epoch: 2,
        investigationId,
        environmentId,
        operations: ["heartbeat"],
        artifactPrefixes: ["inv/"],
        maxBytes: 20n,
        expiresAtMs: 200n,
      }),
    ).toMatchObject({
      scope: { maxBytes: 20 },
      expiresAtMs: 200,
      environmentId,
    });
    expect(
      decodeRevisionLease({
        environmentId,
        holderAttemptId: attemptId,
        grantId: "88888888-8888-4888-8888-888888888888",
        renewedAtMs: 100n,
        expiresAtMs: 200n,
      }),
    ).toMatchObject({ renewedAtMs: 100, expiresAtMs: 200 });
  });

  it("decodes finding evidence in ordinal order and parses JSON locators", () => {
    expect(
      decodeFinding(
        {
          id: findingId,
          investigationId,
          environmentId,
          kind: "behavioral_note",
          summary: "measured result",
          createdAtMs: 123n,
        },
        [
          {
            id: 2n,
            findingId,
            ordinal: 1,
            kind: "log_excerpt",
            locatorJson: '{"line":2}',
          },
          {
            id: 1n,
            findingId,
            ordinal: 0,
            kind: "metric",
            locatorJson: '{"frame":1}',
            artifactId,
          },
        ],
      ),
    ).toMatchObject({
      createdAtMs: 123,
      evidence: [
        { kind: "metric", artifactId, locator: { frame: 1 } },
        { kind: "log_excerpt", locator: { line: 2 } },
      ],
    });
  });

  it("decodes live findings and reports revoked findings with filtered evidence", () => {
    const result = decodeLiveFindings(
      [
        {
          id: findingId,
          investigationId,
          environmentId,
          kind: "behavioral_note",
          summary: "live finding",
          createdAtMs: 123n,
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          investigationId,
          environmentId,
          kind: "behavioral_note",
          summary: "revoked finding",
          createdAtMs: 124n,
        },
      ],
      [
        { id: 1n, findingId, ordinal: 0, kind: "metric", locatorJson: "{}" },
        { id: 2n, findingId, ordinal: 1, kind: "log_excerpt", locatorJson: "{}", artifactId },
      ],
      [
        { key: `evidence:2`, targetKind: "evidence", targetId: "2", reason: "bad evidence", createdAtMs: 125n },
        {
          key: "finding:88888888-8888-4888-8888-888888888888",
          targetKind: "finding",
          targetId: "88888888-8888-4888-8888-888888888888",
          reason: "withdrawn",
          createdAtMs: 126n,
        },
      ],
    );
    expect(result.live).toHaveLength(1);
    expect(result.live[0]?.evidence).toHaveLength(1);
    expect(result.revoked).toEqual([
      {
        findingId: "88888888-8888-4888-8888-888888888888",
        reason: "withdrawn",
        tombstonedAtMs: 126,
      },
    ]);
  });

  it("decodes live candidates and reports tombstoned candidate sources", () => {
    const result = decodeLiveCandidates(
      [{
        id: candidateId,
        investigationId,
        environmentId,
        controllerSha256: sha256,
        sourceArtifactId: artifactId,
        changedFunctions: [],
        basedOnFindings: [],
        submittedByAttemptId: attemptId,
        submittedAtMs: 100n,
      }],
      [],
      [],
      [{
        key: `artifact:${artifactId}`,
        targetKind: "artifact",
        targetId: artifactId,
        reason: "invalid source",
        createdAtMs: 101n,
      }],
    );
    expect(result.live).toEqual([]);
    expect(result.revoked).toEqual([{
      candidateId,
      reason: "invalid source",
      tombstonedAtMs: 101,
    }]);
  });

  it("derives candidate status and parses evaluation/review rows", () => {
    const candidateRow = {
      id: candidateId,
      investigationId,
      environmentId,
      controllerSha256: sha256,
      sourceArtifactId: artifactId,
      changedFunctions: ["move"],
      basedOnFindings: [findingId],
      submittedByAttemptId: attemptId,
      submittedAtMs: 100n,
    };
    expect(decodeCandidate(candidateRow, [], [], false)).toMatchObject({ status: "submitted" });
    expect(
      decodeCandidate(
        candidateRow,
        [
          {
            id: evaluationId,
            candidateId,
            investigationId,
            evaluatorAttemptId: attemptId,
            suite: "public",
            cases: [],
            allRequiredPassed: false,
            status: "failed",
            createdAtMs: 100n,
          },
        ],
        [],
        false,
      ),
    ).toMatchObject({ status: "evaluated" });
    expect(
      decodeCandidate(candidateRow, [], [], true),
    ).toMatchObject({ status: "withdrawn" });
    expect(
      decodeEvaluation({
        id: evaluationId,
        candidateId,
        investigationId,
        evaluatorAttemptId: attemptId,
        suite: "public",
        cases: [{ caseId: "nominal", status: "passed", failureKinds: [] }],
        allRequiredPassed: true,
        status: "passed",
        createdAtMs: 100n,
      }),
    ).toMatchObject({ status: "passed", createdAtMs: 100 });
    expect(
      decodeReview({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        investigationId,
        candidateId,
        evaluationId,
        controllerSha256: sha256,
        decision: "approved",
        reviewerIdentity: "local-reviewer",
        createdAtMs: 101n,
      }),
    ).toMatchObject({ decision: "approved", createdAtMs: 101 });
  });

  it("parses outbox and experiment payloads and bigint fields", () => {
    expect(
      decodeOutbox({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        destination: "elastic_index",
        status: "pending",
        idempotencyKey: "finding:123:index",
        operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        payloadJson: '{"kind":"finding","id":"x"}',
        attempts: 0,
        createdAtMs: 20n,
      }),
    ).toMatchObject({ payload: { kind: "finding" }, createdAtMs: 20 });
    expect(
      decodeExperiment({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        investigationId,
        environmentId,
        attemptId,
        epoch: 1,
        simCase: {
          caseId: "nominal",
          suite: "original",
          seed: 7,
          sceneOverridesJson: '{"divider":0.3}',
        },
        status: "succeeded",
        failureKinds: [],
        completed: true,
        changedFunctions: [],
        engineVersion: "3.3.0",
        assetsSha256: sha256,
        controllerSha256: sha256,
        startedAtMs: 10n,
        finishedAtMs: 20n,
      }),
    ).toMatchObject({
      simCase: { sceneOverrides: { divider: 0.3 } },
      startedAtMs: 10,
      finishedAtMs: 20,
    });
    expect(
      decodeArtifact({
        id: artifactId,
        kind: "controller_source",
        sha256,
        bytes: 32n,
        storage: "local_fs",
        storageKey: "inv/source",
        producedByAttemptId: attemptId,
        createdAtMs: 30n,
      }),
    ).toMatchObject({ bytes: 32, createdAtMs: 30 });
  });
});
