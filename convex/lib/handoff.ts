import { HANDOFF_ORDER, type HandoffStage } from "@forksafe/contracts";

export type HandoffRow = {
  stage: HandoffStage;
  detail?: Record<string, unknown>;
  attemptId?: string;
  epoch?: number;
  stale?: boolean;
};

export function validateStageTransition(
  existingStagesForAttempt: readonly HandoffRow[],
  stage: HandoffStage,
): { result: "next" } | { result: "duplicate"; existing: HandoffRow } | { result: "out_of_order" } {
  const existing = existingStagesForAttempt.find((row) => row.stage === stage);
  if (existing) return { result: "duplicate", existing };
  const expected = HANDOFF_ORDER[existingStagesForAttempt.length];
  return expected === stage ? { result: "next" } : { result: "out_of_order" };
}

export function stageToJobState(stage: HandoffStage):
  | "reserved"
  | "granted"
  | "running"
  | "evidence_pending"
  | "acknowledged" {
  switch (stage) {
    case "admission_reserved": return "reserved";
    case "grant_installed": return "granted";
    case "work_started": return "running";
    case "artifacts_persisted":
    case "evidence_committed": return "evidence_pending";
    case "completion_acknowledged": return "acknowledged";
  }
}

export type HandoffJob = {
  state: string;
  epoch: number;
  activeAttemptId?: string;
};

export function reconcileHandoff(input: {
  job: HandoffJob;
  attempt: { appId: string; epoch: number; leasedUntilMs: number; startedAtMs: number } | null;
  stages: readonly HandoffRow[];
  now: number;
  grantInstallTimeoutMs: number;
}):
  | { action: "none" | "await_evidence_commit" | "retry_evidence_commit" | "expire_attempt" | "grant_install_timeout" | "inconsistent" }
  | { action: "acknowledge_completion"; evidenceIds: unknown[] } {
  const { job, attempt, stages, now, grantInstallTimeoutMs } = input;
  if (
    ["succeeded", "failed", "cancelled"].includes(job.state) ||
    stages.some((row) => row.stage === "completion_acknowledged")
  ) return { action: "none" };

  const ordered = HANDOFF_ORDER.filter((stage) => stages.some((row) => row.stage === stage));
  if (ordered.some((stage, index) => HANDOFF_ORDER[index] !== stage)) return { action: "inconsistent" };
  const committed = stages.find((row) => row.stage === "evidence_committed");
  if (committed && attempt && attempt.epoch === job.epoch && job.activeAttemptId === attempt.appId) {
    const evidenceIds = committed.detail?.evidenceIds;
    return { action: "acknowledge_completion", evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : [] };
  }
  if (stages.some((row) => row.stage === "artifacts_persisted")) {
    return attempt && now <= attempt.leasedUntilMs
      ? { action: "await_evidence_commit" }
      : { action: "retry_evidence_commit" };
  }
  if (
    attempt &&
    now - attempt.startedAtMs > grantInstallTimeoutMs &&
    !stages.some((row) => row.stage === "grant_installed")
  ) return { action: "grant_install_timeout" };
  if (
    attempt &&
    (stages.some((row) => row.stage === "work_started" || row.stage === "grant_installed")) &&
    now > attempt.leasedUntilMs
  ) return { action: "expire_attempt" };
  return { action: "none" };
}
