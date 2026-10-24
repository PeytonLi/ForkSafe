import { z } from "zod";

/** Honest integration status. Everything user-visible reports through this. */
export const IntegrationMode = z.enum([
  "live", // real sponsor service
  "local", // real software running locally (e.g. local Convex, docker Elastic)
  "fixture", // deterministic recorded responses, clearly labeled
  "blocked", // intended but missing credentials/access
  "not_implemented",
]);
export type IntegrationMode = z.infer<typeof IntegrationMode>;

export const InvestigationState = z.enum([
  "capturing", // baseline failure being recorded
  "admitted", // accepted for investigation
  "searching",
  "evaluating", // finalists under protected evaluation
  "awaiting_review", // evaluation complete, human review open
  "completed",
  "cancelled",
  "failed",
]);
export type InvestigationState = z.infer<typeof InvestigationState>;

export const EnvironmentState = z.enum([
  "provisioning",
  "active",
  "paused",
  "closing",
  "closed",
  "error",
]);
export type EnvironmentState = z.infer<typeof EnvironmentState>;

export const JobKind = z.enum([
  "provision_sandbox",
  "factory_session",
  "run_experiment",
  "submit_candidate",
  "evaluate_candidate",
  "elastic_index",
  "jira_sync",
  "cleanup",
]);
export type JobKind = z.infer<typeof JobKind>;

export const JobState = z.enum([
  "reserved", // admission reserved in Convex
  "grant_pending", // Convex→SpacetimeDB grant install in flight
  "granted",
  "running",
  "artifacts_pending",
  "evidence_pending",
  "acknowledged", // completion acknowledged by Convex
  "succeeded",
  "failed",
  "cancelled",
]);
export type JobState = z.infer<typeof JobState>;

export const AttemptState = z.enum([
  "leased",
  "heartbeating",
  "completing",
  "succeeded",
  "failed",
  "expired",
  "fenced", // superseded by a newer epoch; results rejected
]);
export type AttemptState = z.infer<typeof AttemptState>;

export const SessionState = z.enum([
  "created",
  "streaming",
  "idle",
  "budget_exhausted",
  "closed",
  "error",
]);
export type SessionState = z.infer<typeof SessionState>;

export const ExperimentStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "physics_failure",
  "constraint_violation",
  "engine_error",
  "invalid",
  "cancelled",
]);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;

export const FailureKind = z.enum([
  "forbidden_contact", // robot/cube vs divider/wall beyond threshold
  "joint_limit",
  "command_limit",
  "nonfinite_command",
  "stalled", // stopped without completion
  "timeout",
  "engine_error",
  "missing_artifact",
  "invalid_run",
]);
export type FailureKind = z.infer<typeof FailureKind>;

export const FindingKind = z.enum([
  "collision_frame",
  "limit_violation",
  "behavioral_note",
  "candidate_hypothesis",
  "cross_environment_pattern",
]);
export type FindingKind = z.infer<typeof FindingKind>;

export const EvidenceKind = z.enum([
  "trace_frame",
  "contact_event",
  "metric",
  "log_excerpt",
  "code_diff",
  "replay_segment",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const CandidateStatus = z.enum([
  "submitted", // immutable record written
  "evaluating",
  "evaluated",
  "rejected",
  "withdrawn",
]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const EvaluationStatus = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "invalid",
]);
export type EvaluationStatus = z.infer<typeof EvaluationStatus>;

export const ReviewDecision = z.enum(["approved", "rejected", "needs_changes"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

export const ArtifactKind = z.enum([
  "trace",
  "replay",
  "controller_source",
  "log",
  "report",
  "screenshot",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const OutboxStatus = z.enum(["pending", "delivered", "dead"]);
export type OutboxStatus = z.infer<typeof OutboxStatus>;

export const OutboxDestination = z.enum([
  "elastic_index",
  "jira_sync",
  "confluence_link",
]);
export type OutboxDestination = z.infer<typeof OutboxDestination>;
