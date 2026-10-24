export type LogicError = { ok: false; code: string; message: string };
export type LogicSuccess<T> = { ok: true } & T;
export type LogicResult<T> = LogicSuccess<T> | LogicError;

export interface GrantLike {
  id: string;
  jobId: string;
  attemptId: string;
  epoch: number;
  investigationId: string;
  environmentId?: string;
  operations: string[];
  artifactPrefixes: string[];
  maxBytes: number;
  bytesUsed: number;
  expiresAtMs: number;
  revokedAtMs?: number;
  revokeReason?: string;
  holder?: string;
}

export interface FenceLike {
  jobId: string;
  epoch: number;
  grantId: string;
}

export interface GrantRef {
  grantId: string;
  attemptId: string;
  epoch: number;
}

export interface RevisionHeadLike {
  environmentId: string;
  headRevisionId: string;
  seq: number;
}

export interface RevisionLeaseLike {
  environmentId: string;
  holderAttemptId: string;
  grantId: string;
  epoch: number;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
}

export interface OutboxLike {
  id: string;
  destination: string;
  payloadJson: string;
  idempotencyKey: string;
  status: string;
  operationId: string;
  sourceKind: string;
  sourceId: string;
  attempts: number;
  lastError?: string;
  createdAtMs: number;
  deliveredAtMs?: number;
}

export interface EvaluationLike {
  id: string;
  candidateId: string;
  evaluatorAttemptId: string;
  status: string;
}
