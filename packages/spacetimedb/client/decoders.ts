import {
  ArtifactRef,
  CandidateEvaluation,
  ControllerCandidate,
  ExecutionGrant,
  ExperimentResult,
  Finding,
  HumanReview,
  OutboxEntry,
  RevisionLease,
} from "@forksafe/contracts";
import { deriveCandidateStatus } from "../src/logic/candidates.js";
import { buildTombstoneIndex, partitionCandidates, partitionFindings } from "../src/logic/tombstones.js";

export interface GrantRow {
  id: string;
  jobId: string;
  attemptId: string;
  epoch: number;
  investigationId: string;
  environmentId?: string;
  operations: string[];
  artifactPrefixes: string[];
  maxBytes: bigint;
  expiresAtMs: bigint;
  revokedAtMs?: bigint;
}

export interface RevisionLeaseRow {
  environmentId: string;
  holderAttemptId: string;
  grantId: string;
  renewedAtMs: bigint;
  expiresAtMs: bigint;
}

export interface FindingRow {
  id: string;
  investigationId: string;
  environmentId: string;
  sessionId?: string;
  kind: string;
  summary: string;
  createdAtMs: bigint;
}

export interface EvidenceRow {
  id: bigint;
  findingId: string;
  ordinal: number;
  kind: string;
  artifactId?: string;
  experimentId?: string;
  locatorJson: string;
  excerpt?: string;
}

export interface CandidateRow {
  id: string;
  investigationId: string;
  environmentId: string;
  controllerSha256: string;
  sourceArtifactId: string;
  changedFunctions: string[];
  rationale?: string;
  basedOnFindings: string[];
  submittedByAttemptId: string;
  submittedAtMs: bigint;
}

export interface EvaluationRow {
  id: string;
  candidateId: string;
  investigationId: string;
  evaluatorAttemptId: string;
  suite: string;
  cases: Array<{
    caseId: string;
    status: string;
    experimentId?: string;
    completionTimeSec?: number;
    failureKinds: string[];
  }>;
  allRequiredPassed: boolean;
  medianCompletionTimeSec?: number;
  status: string;
  reportArtifactId?: string;
  createdAtMs: bigint;
}

export interface ReviewRow {
  id: string;
  investigationId: string;
  candidateId: string;
  evaluationId: string;
  controllerSha256: string;
  decision: string;
  reviewerIdentity: string;
  notes?: string;
  jiraIssueKey?: string;
  createdAtMs: bigint;
}

export interface OutboxRow {
  id: string;
  destination: string;
  status: string;
  idempotencyKey: string;
  operationId: string;
  payloadJson: string;
  attempts: number;
  lastError?: string;
  createdAtMs: bigint;
  deliveredAtMs?: bigint;
}

export interface ExperimentRow {
  id: string;
  investigationId: string;
  environmentId?: string;
  candidateId?: string;
  attemptId: string;
  epoch: number;
  simCase: {
    caseId: string;
    suite: string;
    seed: number;
    sceneOverridesJson: string;
    description?: string;
  };
  status: string;
  failureKinds: string[];
  completed: boolean;
  completionTimeSec?: number;
  changedFunctions: string[];
  traceArtifactId?: string;
  replayArtifactId?: string;
  engineVersion: string;
  assetsSha256: string;
  controllerSha256: string;
  startedAtMs: bigint;
  finishedAtMs?: bigint;
}

export interface TombstoneRow {
  key: string;
  targetKind: string;
  targetId: string;
  reason: string;
  createdAtMs: bigint;
}

const asNumber = (value: bigint): number => Number(value);

function decodeLocator(locatorJson: string): Record<string, unknown> {
  const locator: unknown = JSON.parse(locatorJson);
  if (locator === null || typeof locator !== "object" || Array.isArray(locator)) {
    throw new TypeError("Evidence locator must be a JSON object");
  }
  return locator as Record<string, unknown>;
}

export function decodeGrant(row: GrantRow) {
  const grant = {
    id: row.id,
    jobId: row.jobId,
    attemptId: row.attemptId,
    epoch: row.epoch,
    investigationId: row.investigationId,
    scope: {
      operations: row.operations,
      artifactPrefixes: row.artifactPrefixes,
      maxBytes: asNumber(row.maxBytes),
    },
    expiresAtMs: asNumber(row.expiresAtMs),
    ...(row.environmentId === undefined ? {} : { environmentId: row.environmentId }),
    ...(row.revokedAtMs === undefined ? {} : { revokedAtMs: asNumber(row.revokedAtMs) }),
  };
  return ExecutionGrant.parse(grant);
}

export function decodeRevisionLease(row: RevisionLeaseRow) {
  return RevisionLease.parse({
    environmentId: row.environmentId,
    holderAttemptId: row.holderAttemptId,
    grantId: row.grantId,
    renewedAtMs: asNumber(row.renewedAtMs),
    expiresAtMs: asNumber(row.expiresAtMs),
  });
}

export function decodeFinding(row: FindingRow, evidenceRows: EvidenceRow[]) {
  const decoded = {
    id: row.id,
    investigationId: row.investigationId,
    environmentId: row.environmentId,
    kind: row.kind,
    summary: row.summary,
    evidence: evidenceRows
      .filter((evidence) => evidence.findingId === row.id)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((evidence) => ({
        kind: evidence.kind,
        locator: decodeLocator(evidence.locatorJson),
        ...(evidence.artifactId === undefined ? {} : { artifactId: evidence.artifactId }),
        ...(evidence.experimentId === undefined ? {} : { experimentId: evidence.experimentId }),
        ...(evidence.excerpt === undefined ? {} : { excerpt: evidence.excerpt }),
      })),
    createdAtMs: asNumber(row.createdAtMs),
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
  };
  return Finding.parse(decoded);
}

export function decodeCandidate(
  row: CandidateRow,
  evaluations: EvaluationRow[],
  reviews: ReviewRow[],
  isTombstoned: boolean,
) {
  const status = deriveCandidateStatus({
    tombstoned: isTombstoned,
    evaluations: evaluations.filter((evaluation) => evaluation.candidateId === row.id),
    reviews: reviews.filter((review) => review.candidateId === row.id),
  });
  return ControllerCandidate.parse({
    id: row.id,
    investigationId: row.investigationId,
    environmentId: row.environmentId,
    status,
    controllerSha256: row.controllerSha256,
    sourceArtifactId: row.sourceArtifactId,
    changedFunctions: row.changedFunctions,
    basedOnFindings: row.basedOnFindings,
    submittedByAttemptId: row.submittedByAttemptId,
    submittedAtMs: asNumber(row.submittedAtMs),
    ...(row.rationale === undefined ? {} : { rationale: row.rationale }),
  });
}

export function decodeEvaluation(row: EvaluationRow) {
  return CandidateEvaluation.parse({
    id: row.id,
    candidateId: row.candidateId,
    investigationId: row.investigationId,
    evaluatorAttemptId: row.evaluatorAttemptId,
    suite: row.suite,
    cases: row.cases,
    allRequiredPassed: row.allRequiredPassed,
    status: row.status,
    createdAtMs: asNumber(row.createdAtMs),
    ...(row.medianCompletionTimeSec === undefined
      ? {}
      : { medianCompletionTimeSec: row.medianCompletionTimeSec }),
    ...(row.reportArtifactId === undefined ? {} : { reportArtifactId: row.reportArtifactId }),
  });
}

export function decodeReview(row: ReviewRow) {
  return HumanReview.parse({
    id: row.id,
    investigationId: row.investigationId,
    candidateId: row.candidateId,
    evaluationId: row.evaluationId,
    controllerSha256: row.controllerSha256,
    decision: row.decision,
    reviewerIdentity: row.reviewerIdentity,
    createdAtMs: asNumber(row.createdAtMs),
    ...(row.notes === undefined ? {} : { notes: row.notes }),
    ...(row.jiraIssueKey === undefined ? {} : { jiraIssueKey: row.jiraIssueKey }),
  });
}

export function decodeOutbox(row: OutboxRow) {
  const payload: unknown = JSON.parse(row.payloadJson);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Outbox payload must be a JSON object");
  }
  return OutboxEntry.parse({
    id: row.id,
    destination: row.destination,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    operationId: row.operationId,
    payload,
    attempts: row.attempts,
    createdAtMs: asNumber(row.createdAtMs),
    ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
    ...(row.deliveredAtMs === undefined ? {} : { deliveredAtMs: asNumber(row.deliveredAtMs) }),
  });
}

export function decodeExperiment(row: ExperimentRow) {
  const simCase = {
    caseId: row.simCase.caseId,
    suite: row.simCase.suite,
    seed: row.simCase.seed,
    sceneOverrides: decodeLocator(row.simCase.sceneOverridesJson),
    ...(row.simCase.description === undefined ? {} : { description: row.simCase.description }),
  };
  const experiment = {
    id: row.id,
    investigationId: row.investigationId,
    attemptId: row.attemptId,
    epoch: row.epoch,
    simCase,
    status: row.status,
    failureKinds: row.failureKinds,
    completed: row.completed,
    changedFunctions: row.changedFunctions,
    engineVersion: row.engineVersion,
    assetsSha256: row.assetsSha256,
    controllerSha256: row.controllerSha256,
    startedAtMs: asNumber(row.startedAtMs),
    ...(row.environmentId === undefined ? {} : { environmentId: row.environmentId }),
    ...(row.candidateId === undefined ? {} : { candidateId: row.candidateId }),
    ...(row.completionTimeSec === undefined ? {} : { completionTimeSec: row.completionTimeSec }),
    ...(row.traceArtifactId === undefined ? {} : { traceArtifactId: row.traceArtifactId }),
    ...(row.replayArtifactId === undefined ? {} : { replayArtifactId: row.replayArtifactId }),
    ...(row.finishedAtMs === undefined ? {} : { finishedAtMs: asNumber(row.finishedAtMs) }),
  };
  return ExperimentResult.parse(experiment);
}

export function decodeArtifact(row: {
  id: string;
  kind: string;
  sha256: string;
  bytes: bigint;
  storage: string;
  storageKey: string;
  producedByAttemptId?: string;
  createdAtMs: bigint;
}) {
  return ArtifactRef.parse({
    id: row.id,
    kind: row.kind,
    sha256: row.sha256,
    bytes: asNumber(row.bytes),
    storage: row.storage,
    storageKey: row.storageKey,
    createdAtMs: asNumber(row.createdAtMs),
    ...(row.producedByAttemptId === undefined
      ? {}
      : { producedByAttemptId: row.producedByAttemptId }),
  });
}

export function decodeLiveFindings(
  findingRows: FindingRow[],
  evidenceRows: EvidenceRow[],
  tombstoneRows: TombstoneRow[],
) {
  const partition = partitionFindings(
    findingRows,
    evidenceRows,
    buildTombstoneIndex(tombstoneRows),
  );
  return {
    live: partition.live.map(({ evidence, ...row }) => decodeFinding(row, evidence)),
    revoked: partition.revoked,
  };
}

export function decodeLiveCandidates(
  candidateRows: CandidateRow[],
  evaluations: EvaluationRow[],
  reviews: ReviewRow[],
  tombstoneRows: TombstoneRow[],
) {
  const partition = partitionCandidates(
    candidateRows,
    buildTombstoneIndex(tombstoneRows),
  );
  return {
    live: partition.live.map((row) => decodeCandidate(row, evaluations, reviews, false)),
    revoked: partition.revoked,
  };
}
