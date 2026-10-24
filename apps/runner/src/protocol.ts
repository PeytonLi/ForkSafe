import { z } from "zod";
import {
  AgentSession,
  Attempt,
  ExecutionGrant,
  Heartbeat,
  Job,
  JobKind,
  VendorRef,
  uuid,
} from "@forksafe/contracts";

export const ClaimRequest = z.object({
  workerId: z.string().min(1),
  kinds: z.array(JobKind),
  capacity: z.number().int().nonnegative(),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const Lease = z.object({ job: Job, attempt: Attempt, grant: ExecutionGrant });
export type Lease = z.infer<typeof Lease>;

export const ClaimResponse = z.object({ lease: Lease.nullable() });
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const HeartbeatResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    leasedUntilMs: z.number().int(),
    grantExpiresAtMs: z.number().int().optional(),
    epoch: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), reason: z.enum(["fenced", "expired", "revoked", "unknown_attempt"]) }),
]);
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const CompletionRequest = z.object({
  operationId: uuid,
  jobId: Job.shape.id,
  attemptId: Attempt.shape.id,
  grantId: ExecutionGrant.shape.id,
  epoch: z.number().int().nonnegative(),
  outcome: z.enum(["succeeded", "failed"]),
  result: z.record(z.unknown()),
  usage: AgentSession.shape.tokenUsage.optional(),
  sessions: z.array(VendorRef),
  finishedAtMs: z.number().int(),
});
export type CompletionRequest = z.infer<typeof CompletionRequest>;

export const CompletionResponse = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type CompletionResponse = z.infer<typeof CompletionResponse>;

export { Heartbeat };
