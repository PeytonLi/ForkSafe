import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";

function failureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return "bridge_call_failed";
}

function reconciliationFailure(
  evaluation: { epoch: number; evaluatorAttemptId: string },
  grant: {
    attemptId: string;
    epoch: number;
    expiresAtMs: number;
    revokedAtMs?: number;
    bridgeMode?: string;
    spacetimeInstalled?: boolean;
    spacetimeRevoked?: boolean;
  } | null,
  attempt: { epoch: number } | null,
  now: number,
): string | undefined {
  if (!grant) return "grant_missing";
  if (grant.revokedAtMs !== undefined || grant.spacetimeRevoked) return "grant_revoked";
  if (grant.expiresAtMs <= now) return "grant_expired";
  if (!attempt) return "grant_inactive";
  if (grant.attemptId !== evaluation.evaluatorAttemptId || grant.epoch !== evaluation.epoch || attempt.epoch !== evaluation.epoch) {
    return "grant_mismatch";
  }
  if (!grant.spacetimeInstalled || (grant.bridgeMode !== "live" && grant.bridgeMode !== "local")) {
    return "grant_unavailable";
  }
  return undefined;
}

export const reconcilePendingCommits = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    checked: number;
    committed: number;
    pending: number;
    failed: number;
    notApplicable: number;
  }> => {
    const rows = await ctx.runQuery(internal.evaluation.pendingCommitRows, {});
    const result = { checked: rows.length, committed: 0, pending: 0, failed: 0, notApplicable: 0 };
    await Promise.all(rows.map(async ({ evaluation, grant, attempt }) => {
      if (grant?.bridgeMode === "fixture" || grant?.bridgeMode === "not_implemented") {
        await ctx.runMutation(internal.evaluation.markCommitStatus, {
          evaluationId: evaluation.appId,
          status: "not_applicable",
        });
        result.notApplicable += 1;
        return;
      }
      const invalidGrant = reconciliationFailure(evaluation, grant, attempt, Date.now());
      if (invalidGrant) {
        await ctx.runMutation(internal.evaluation.markCommitStatus, {
          evaluationId: evaluation.appId,
          status: "commit_failed",
          error: invalidGrant,
        });
        result.failed += 1;
        return;
      }
      try {
        const response = await ctx.runAction(internal.bridge.recordEvaluation, {
          grant: { grantId: grant!.appId, attemptId: evaluation.evaluatorAttemptId, epoch: evaluation.epoch },
          id: evaluation.appId,
          candidateId: evaluation.candidateId,
          investigationId: evaluation.investigationId,
          suite: evaluation.suite,
          cases: evaluation.cases,
          allRequiredPassed: evaluation.allRequiredPassed,
          ...(evaluation.medianCompletionTimeSec !== undefined ? { medianCompletionTimeSec: evaluation.medianCompletionTimeSec } : {}),
          status: evaluation.status,
        });
        const status = response.committed
          ? "committed"
          : response.mode === "fixture" || response.mode === "not_implemented"
            ? "not_applicable"
            : response.mode === "live" || response.mode === "local"
              ? "pending"
              : "commit_failed";
        await ctx.runMutation(internal.evaluation.markCommitStatus, {
          evaluationId: evaluation.appId,
          status,
          ...(!response.committed && (status === "pending" || status === "commit_failed")
            ? { error: "bridge_call_failed" }
            : {}),
        });
        if (status === "committed") result.committed += 1;
        else if (status === "pending") result.pending += 1;
        else if (status === "commit_failed") result.failed += 1;
        else result.notApplicable += 1;
      } catch (error) {
        await ctx.runMutation(internal.evaluation.markCommitStatus, {
          evaluationId: evaluation.appId,
          status: "pending",
          error: failureCode(error),
        });
        result.pending += 1;
      }
    }));
    return result;
  },
});
