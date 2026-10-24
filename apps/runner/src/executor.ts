import { randomUUID } from "node:crypto";
import { ActivityLog, buildRepairPrompt, SessionCapError, type RepairPromptParams, type SessionManager, type TurnOutcome } from "@forksafe/agents";
import { assertFence, StaleLeaseError } from "./fencing.js";
import { LeaseKeeper } from "./heartbeat.js";
import type { JobSource } from "./job-source.js";
import type { CompletionRequest, CompletionResponse, Lease } from "./protocol.js";

export class RunnerExecutor {
  constructor(
    private readonly options: {
      sessions: SessionManager;
      source: JobSource;
      log: ActivityLog;
      clock?: () => number;
      sleep?: (ms: number) => Promise<void>;
      beforeJob?: (lease: Lease) => void;
      maxTurns?: number;
    },
  ) {}

  async execute(lease: Lease): Promise<unknown | null> {
    if (lease.job.kind !== "factory_session") throw new Error(`Unsupported runner job kind: ${lease.job.kind}`);
    if (!lease.job.environmentId) throw new Error("factory_session jobs require environmentId");
    const clock = this.options.clock ?? Date.now;
    const operationId = randomUUID();
    this.options.beforeJob?.(lease);
    let sessionId = this.options.sessions.idleSessionFor(lease.job.investigationId, lease.job.environmentId);
    if (!sessionId) {
      try {
        const created = await this.options.sessions.createSession({
          investigationId: lease.job.investigationId,
          environmentId: lease.job.environmentId,
        });
        sessionId = created.sessionId;
      } catch (error) {
        // Any session-open failure is reported on the lease instead of being left to expire:
        // the cap is a terminal "failed", everything else (e.g. a missing droid executable) is
        // infrastructure and gets the single infra retry.
        const cap = error instanceof SessionCapError;
        return this.completeWithRetry(lease, {
          operationId,
          jobId: lease.job.id,
          attemptId: lease.attempt.id,
          grantId: lease.grant.id,
          epoch: lease.attempt.epoch,
          outcome: cap ? "failed" : "infra_failed",
          result: { error: cap ? "environment_session_cap" : `session_open_failed:${error instanceof Error ? error.message.slice(0, 200) : "unknown"}` },
          sessions: [],
          finishedAtMs: clock(),
        }, clock);
      }
    }
    const keeper = new LeaseKeeper(lease, this.options.source, clock);
    keeper.start();
    let turn: TurnOutcome | undefined;
    let failure: string | undefined;
    const turns: TurnOutcome[] = [];
    try {
      await this.options.source.start?.({ attemptId: lease.attempt.id, epoch: lease.attempt.epoch }).catch(() => undefined);
      const payload = lease.job.payload;
      const prompt = typeof payload.prompt === "string"
        ? payload.prompt
        : payload.repair
          ? buildRepairPrompt(payload.repair as RepairPromptParams)
          : "Review the investigation and use the ForkSafe tools to report evidence-backed findings.";
      const maxTurns = this.options.maxTurns ?? 3;
      for (let index = 0; index < maxTurns; index += 1) {
        turn = await this.options.sessions.runTurn(sessionId, index === 0 ? prompt : CONTINUE_PROMPT, {
          abortSignal: keeper.signal,
          toolContext: {
            attemptId: lease.attempt.id,
            grantId: lease.grant.id,
            epoch: lease.attempt.epoch,
          },
        });
        turns.push(turn);
        if (keeper.signal.aborted) return null;
        await this.options.source.session?.({ attemptId: lease.attempt.id, epoch: lease.attempt.epoch, session: this.options.sessions.toAgentSession(sessionId) }).catch(() => undefined);
        if (!turn.success || turn.mode !== "live" || submittedCandidate(turn)) break;
      }
    } catch (error) {
      if (keeper.signal.aborted) {
        await this.options.sessions.interrupt(sessionId).catch(() => undefined);
        await this.log(lease, "lease abandoned", { reason: String(keeper.signal.reason ?? "aborted") }, sessionId);
        return null;
      }
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      keeper.stop();
    }
    try {
      assertFence(lease, clock());
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        await this.log(lease, "stale result dropped", { reason: error.message }, sessionId);
        return null;
      }
      throw error;
    }
    const session = this.options.sessions.toAgentSession(sessionId);
    const payload = {
      operationId,
      jobId: lease.job.id,
      attemptId: lease.attempt.id,
      grantId: lease.grant.id,
      epoch: lease.attempt.epoch,
      outcome: turn?.success && !failure ? "succeeded" as const : "failed" as const,
      result: turn ? { ...summarize(turn), turns: turns.length, candidateSubmitted: turns.some(submittedCandidate) } : { error: failure ?? "turn did not produce a result" },
      usage: session.tokenUsage,
      sessions: [{ ...session, turns: turns.length }],
      finishedAtMs: clock(),
    };
    return this.completeWithRetry(lease, payload, clock, sessionId);
  }

  private async completeWithRetry(
    lease: Lease,
    payload: CompletionRequest,
    clock: () => number,
    sessionId = "unknown",
  ): Promise<CompletionResponse | null> {
    const backoffs = [250, 500, 1_000];
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)));
    for (let attempt = 0; attempt <= backoffs.length; attempt += 1) {
      try {
        assertFence(lease, clock());
      } catch (error) {
        if (error instanceof StaleLeaseError) {
          await this.log(lease, "stale result dropped", { reason: error.message }, sessionId);
          return null;
        }
        throw error;
      }
      try {
        const response = await this.options.source.complete(payload);
        if (!response.accepted) await this.log(lease, "completion rejected", { reason: response.reason ?? "unknown" }, sessionId);
        return response;
      } catch (error) {
        if (attempt === backoffs.length) throw error;
        await sleep(backoffs[attempt]!);
      }
    }
    throw new Error("Completion retry loop exited unexpectedly");
  }

  private async log(lease: Lease, summary: string, data: Record<string, unknown>, sessionId = "unknown"): Promise<void> {
    await this.options.log.record({
      atMs: (this.options.clock ?? Date.now)(),
      investigationId: lease.job.investigationId,
      environmentId: lease.job.environmentId ?? "unknown",
      sessionId,
      kind: "lifecycle",
      summary,
      data,
    });
  }
}

const CONTINUE_PROMPT = "Continue the repair. If a revision already passes the baseline case, submit_candidate with its revisionId now; otherwise fix the controller with propose_controller_revision and measure it with run_experiment. Report only measured results.";

function submittedCandidate(turn: TurnOutcome): boolean {
  return (turn.toolCalls ?? []).some((call: unknown) => {
    const name = typeof call === "string" ? call : (call as { name?: string; tool?: string })?.name ?? (call as { tool?: string })?.tool;
    return name === "submit_candidate" || name === "mcp__forksafe__submit_candidate";
  });
}

function summarize(turn: TurnOutcome): Record<string, unknown> {
  return {
    mode: turn.mode,
    success: turn.success,
    text: turn.text,
    toolCalls: turn.toolCalls,
    tokenUsage: turn.tokenUsage,
    durationMs: turn.durationMs,
    session: turn.vendorRef,
  };
}
