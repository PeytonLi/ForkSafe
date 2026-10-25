export const LEASE_RENEW_INTERVAL_MS = 5_000;
export const LEASE_TTL_MS = 30_000;
export const OUTBOX_MAX_ATTEMPTS = 8;
export const MAX_TEXT = 4_000;

export const GRANT_OPS = [
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
] as const;

export const FINDING_KINDS = [
  "collision_frame",
  "limit_violation",
  "behavioral_note",
  "candidate_hypothesis",
  "cross_environment_pattern",
] as const;
export const EVIDENCE_KINDS = [
  "trace_frame",
  "contact_event",
  "metric",
  "log_excerpt",
  "code_diff",
  "replay_segment",
] as const;
export const CANDIDATE_STATUSES = [
  "submitted",
  "evaluating",
  "evaluated",
  "rejected",
  "withdrawn",
] as const;
export const EVALUATION_STATUSES = ["queued", "running", "passed", "failed", "invalid"] as const;
export const REVIEW_DECISIONS = ["approved", "rejected", "needs_changes"] as const;
export const ARTIFACT_KINDS = [
  "trace",
  "replay",
  "controller_source",
  "log",
  "report",
  "screenshot",
] as const;
export const OUTBOX_STATUSES = ["pending", "delivered", "dead"] as const;
export const OUTBOX_DESTINATIONS = ["elastic_index", "jira_sync", "confluence_link"] as const;
export const EXPERIMENT_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "physics_failure",
  "constraint_violation",
  "engine_error",
  "invalid",
  "cancelled",
] as const;
export const FAILURE_KINDS = [
  "forbidden_contact",
  "joint_limit",
  "command_limit",
  "nonfinite_command",
  "stalled",
  "timeout",
  "engine_error",
  "missing_artifact",
  "invalid_run",
  "dropped_early",
  "bounced_out",
  "missed_bin_short",
  "missed_bin_long",
] as const;

export const CLAIMS = ["observation", "inference"] as const;
export const FINDING_LINK_RELATIONS = [
  "supports",
  "contradicts",
  "replicates",
  "supersedes",
] as const;
export const TOMBSTONE_TARGET_KINDS = [
  "finding",
  "candidate",
  "evidence",
  "artifact",
] as const;
export const ARTIFACT_STORAGES = ["convex", "local_fs"] as const;
