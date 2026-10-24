import { z } from "zod";

/** Application IDs are stable UUIDs minted by ForkSafe services.
 *  Vendor IDs (Convex doc IDs, SpacetimeDB identities, Daytona sandbox IDs,
 *  Factory session IDs, Jira issue keys) are stored separately and never
 *  substitute for application IDs. */
export const uuid = z.string().uuid();

const branded = <T extends string>(_tag: T) => uuid;

export const InvestigationId = branded("InvestigationId");
export const EnvironmentId = branded("EnvironmentId");
export const JobId = branded("JobId");
export const AttemptId = branded("AttemptId");
export const GrantId = branded("GrantId");
export const SessionId = branded("SessionId");
export const ExperimentId = branded("ExperimentId");
export const FindingId = branded("FindingId");
export const CandidateId = branded("CandidateId");
export const EvaluationId = branded("EvaluationId");
export const ReviewId = branded("ReviewId");
export const ArtifactId = branded("ArtifactId");
export const OutboxId = branded("OutboxId");
export const OperationId = branded("OperationId");

export type InvestigationId = z.infer<typeof InvestigationId>;
export type EnvironmentId = z.infer<typeof EnvironmentId>;
export type JobId = z.infer<typeof JobId>;
export type AttemptId = z.infer<typeof AttemptId>;
export type GrantId = z.infer<typeof GrantId>;
export type SessionId = z.infer<typeof SessionId>;
export type ExperimentId = z.infer<typeof ExperimentId>;
export type FindingId = z.infer<typeof FindingId>;
export type CandidateId = z.infer<typeof CandidateId>;
export type EvaluationId = z.infer<typeof EvaluationId>;
export type ReviewId = z.infer<typeof ReviewId>;
export type ArtifactId = z.infer<typeof ArtifactId>;
export type OutboxId = z.infer<typeof OutboxId>;
export type OperationId = z.infer<typeof OperationId>;

/** Opaque vendor identifiers, always stored alongside their provider tag. */
export const VendorRef = z.object({
  provider: z.enum([
    "convex",
    "spacetimedb",
    "daytona",
    "factory",
    "elastic",
    "jira",
    "confluence",
    "local",
  ]),
  id: z.string().min(1),
});
export type VendorRef = z.infer<typeof VendorRef>;
