import { z } from "zod";
import { AttemptId, ExperimentId, GrantId, JobId, OperationId } from "./ids.js";
import { ExperimentResult, Finding, ExecutionGrant } from "./entities.js";

/** Convex → SpacetimeDB handoff stages (no distributed transaction).
 *  Durable operation ids + reconciliation, per PRD. */
export const HandoffStage = z.enum([
  "admission_reserved",
  "grant_installed",
  "work_started",
  "artifacts_persisted",
  "evidence_committed",
  "completion_acknowledged",
]);
export type HandoffStage = z.infer<typeof HandoffStage>;

export const HANDOFF_ORDER: readonly HandoffStage[] = [
  "admission_reserved",
  "grant_installed",
  "work_started",
  "artifacts_persisted",
  "evidence_committed",
  "completion_acknowledged",
];

export const HandoffRecord = z.object({
  operationId: OperationId,
  jobId: JobId,
  stage: HandoffStage,
  attemptId: AttemptId.optional(),
  grantId: GrantId.optional(),
  detail: z.record(z.unknown()).default({}),
  atMs: z.number().int(),
});
export type HandoffRecord = z.infer<typeof HandoffRecord>;

/** Worker heartbeat payload. */
export const Heartbeat = z.object({
  attemptId: AttemptId,
  grantId: GrantId,
  epoch: z.number().int().nonnegative(),
  atMs: z.number().int(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/** Result a worker posts for an experiment attempt. Rejected unless the
 *  attempt+epoch still match and the grant is unexpired/unrevoked. */
export const ExperimentCommit = z.object({
  operationId: OperationId,
  grant: ExecutionGrant,
  result: ExperimentResult,
});
export type ExperimentCommit = z.infer<typeof ExperimentCommit>;

export const FindingCommit = z.object({
  operationId: OperationId,
  grantId: GrantId,
  attemptId: AttemptId,
  epoch: z.number().int().nonnegative(),
  findings: z.array(Finding),
});
export type FindingCommit = z.infer<typeof FindingCommit>;

/** Serialized result envelope emitted by the simulator/evaluator services. */
export const SimRunRequest = z.object({
  experimentId: ExperimentId,
  seed: z.number().int().nonnegative(),
  controllerDir: z.string().min(1), // mounted controller source
  caseId: z.string().min(1),
  timeoutSec: z.number().positive().default(30),
  outDir: z.string().min(1),
});
export type SimRunRequest = z.infer<typeof SimRunRequest>;

export const SimFrame = z.object({
  tSec: z.number().nonnegative(),
  qpos: z.array(z.number()),
  qvel: z.array(z.number()),
  ctrl: z.array(z.number()),
  /** [body, geom, positions] minimal replay state, sampled at viewer rate. */
  bodies: z.array(
    z.object({
      name: z.string(),
      pos: z.tuple([z.number(), z.number(), z.number()]),
      quat: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    }),
  ),
  contacts: z.array(
    z.object({ a: z.string(), b: z.string(), depthM: z.number() }),
  ),
  cubePos: z.tuple([z.number(), z.number(), z.number()]).optional(),
  attached: z.boolean().default(false),
});
export type SimFrame = z.infer<typeof SimFrame>;

export const SimRunResult = z.object({
  experimentId: ExperimentId,
  completed: z.boolean(),
  completionTimeSec: z.number().nonnegative().optional(),
  failureKinds: z.array(z.string()),
  firstFailure: z
    .object({ kind: z.string(), tSec: z.number(), detail: z.string() })
    .optional(),
  frames: z.array(SimFrame), // sampled
  engineVersion: z.string(),
  assetsSha256: z.string().length(64),
  controllerSha256: z.string().length(64),
});
export type SimRunResult = z.infer<typeof SimRunResult>;
