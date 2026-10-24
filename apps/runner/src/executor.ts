import { randomUUID } from "node:crypto";
import { context, trace, type Context, type Span } from "@opentelemetry/api";
import { ActivityLog, buildRepairPrompt, SessionCapError, type RepairPromptParams, type SessionManager, type TurnOutcome } from "@forksafe/agents";
import { safeAttributes, tokenAttributes } from "@forksafe/telemetry";
import { assertFence, StaleLeaseError } from "./fencing.js";
import { FencedError } from "./job-source.js";
import { LeaseKeeper } from "./heartbeat.js";
import type { JobSource } from "./job-source.js";
import type { CompletionRequest, CompletionResponse, Lease } from "./protocol.js";
import type { RunnerTelemetry } from "./telemetry.js";

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
      telemetry?: RunnerTelemetry;
    },
  ) {}

  async execute(lease: Lease, traceContext?: Context): Promise<unknown | null> {
    const runnerTelemetry = this.options.telemetry;
    const job = runnerTelemetry
      ? traceContext
        ? { span: trace.getSpan(traceContext), context: traceContext, end: () => trace.getSpan(traceContext)?.end() }
        : runnerTelemetry.telemetry.startSpan("runner.job", { "forksafe.job_id": lease.job.id })
      : undefined;
    job?.span?.setAttribute("forksafe.job_id", lease.job.id);
    job?.span?.setAttribute("forksafe.attempt_id", lease.attempt.id);
    runnerTelemetry?.beginAttempt(lease.attempt.id);
    try {
      const result = await this.executeJob(lease, job?.context, job?.span);
      if (result === null) job?.span?.setAttribute("forksafe.lease.abort_reason", "lease_aborted");
      return result;
    } catch (error) {
      job?.span?.setAttribute("error.type", error instanceof Error ? error.name : "Error");
      job?.span?.setAttribute("forksafe.outcome", "error");
      throw error;
    } finally {
      runnerTelemetry?.finishAttempt(lease.attempt.id);
      job?.end();
    }
  }

  private async executeJob(lease: Lease, traceContext?: Context, jobSpan?: Span): Promise<unknown | null> {
    if (lease.job.kind !== "factory_session") throw new Error(`Unsupported runner job kind: ${lease.job.kind}`);
    const environmentId = lease.job.environmentId;
    if (!environmentId) throw new Error("factory_session jobs require environmentId");
    const clock = this.options.clock ?? Date.now;
    const operationId = randomUUID();
    this.options.beforeJob?.(lease);
    const checkpoint = lease.job.payload.resume as {
      sessionId?: string; vendorSessionId?: string; turnIndex?: number; revisionHeadId?: string;
    } | undefined;
    let sessionId = this.options.sessions.idleSessionFor(lease.job.investigationId, environmentId);
    if (!sessionId) {
      try {
        const openSession = () => checkpoint?.vendorSessionId && checkpoint.sessionId
          ? this.options.sessions.resumeFromCheckpoint({
            investigationId: lease.job.investigationId, environmentId,
            sessionId: checkpoint.sessionId, vendorSessionId: checkpoint.vendorSessionId,
          })
          : this.options.sessions.createSession({ investigationId: lease.job.investigationId, environmentId });
        const created = this.options.telemetry
          ? await this.options.telemetry.telemetry.withSpan("runner.session.open", {}, openSession, { parent: traceContext })
          : await openSession();
        sessionId = created.sessionId;
      } catch (error) {
        // Any session-open failure is reported on the lease instead of being left to expire:
        // the cap is a terminal "failed", everything else (e.g. a missing droid executable) is
        // infrastructure and gets the single infra retry.
        const cap = error instanceof SessionCapError;
        const outcome = cap ? "failed" : "infra_failed";
        jobSpan?.setAttribute("forksafe.outcome", outcome);
        return this.completeWithRetry(lease, {
          operationId,
          jobId: lease.job.id,
          attemptId: lease.attempt.id,
          grantId: lease.grant.id,
          epoch: lease.attempt.epoch,
          outcome,
          result: { error: cap ? "environment_session_cap" : `session_open_failed:${error instanceof Error ? error.message.slice(0, 200) : "unknown"}` },
          sessions: [],
          finishedAtMs: clock(),
        }, clock, "unknown", traceContext, jobSpan);
      }
    }
    const keeper = new LeaseKeeper(lease, this.options.source, clock);
    keeper.start();
    let turn: TurnOutcome | undefined;
    let failure: string | undefined;
    let infrastructureFailure = false;
    const turns: TurnOutcome[] = [];
    try {
      const grant = async () => {
        assertFence(lease, clock());
        await this.options.sessions.registerSession(sessionId!, {
          attemptId: lease.attempt.id,
          grantId: lease.grant.id,
          epoch: lease.attempt.epoch,
          jobId: lease.job.id,
        });
        await this.options.source.start?.({ attemptId: lease.attempt.id, epoch: lease.attempt.epoch }).catch(() => undefined);
      };
      if (this.options.telemetry) {
        await this.options.telemetry.telemetry.withSpan("runner.grant", {
          "forksafe.grant_id": lease.grant.id,
          "forksafe.epoch": lease.attempt.epoch,
          "forksafe.attempt_id": lease.attempt.id,
        }, grant, { parent: traceContext });
      } else {
        await grant();
      }
      const payload = lease.job.payload;
      const prompt = typeof payload.prompt === "string"
        ? payload.prompt
        : payload.repair
          ? buildRepairPrompt(payload.repair as RepairPromptParams)
          : "Review the investigation and use the ForkSafe tools to report evidence-backed findings.";
      const maxTurns = this.options.maxTurns ?? 4;
      const startTurn = checkpoint?.turnIndex !== undefined ? checkpoint.turnIndex + 1 : 0;
      const turnBudget = { used: startTurn, max: maxTurns };
      const revisionState = { headRevisionId: checkpoint?.revisionHeadId };
      for (let index = startTurn; index < maxTurns; index += 1) {
        if (turnBudget.used >= turnBudget.max) break;
        turnBudget.used += 1;
        const turnPrompt = index === startTurn && checkpoint
          ? `Continue from checkpoint at revision head ${checkpoint.revisionHeadId ?? "baseline"}. ${CONTINUE_PROMPT}`
          : index === 0 ? prompt : CONTINUE_PROMPT;
        const turnOptions = {
          abortSignal: keeper.signal,
          toolContext: {
            attemptId: lease.attempt.id,
            grantId: lease.grant.id,
            epoch: lease.attempt.epoch,
            turnBudget,
            revisionState,
            jobId: lease.job.id,
            turnIndex: turnBudget.used - 1,
          },
        };
        const turnIndex = turnBudget.used - 1;
        const sessionProjection = this.options.sessions.toAgentSession(sessionId);
        const turnAttrs: Record<string, unknown> = {
          "forksafe.turn.index": turnIndex,
          "forksafe.turn.mode": "unknown",
          "forksafe.session_id": sessionId,
          "forksafe.vendor_session_id": sessionProjection.factorySession?.id ?? "unknown",
        };
        const runTurn = async (span?: Span): Promise<TurnOutcome> => {
          this.options.telemetry?.setTurnContext(lease.attempt.id, context.active());
          this.options.telemetry?.telemetry.metrics.turnActive(1);
          try {
            const outcome = await this.options.sessions.runTurn(sessionId!, turnPrompt, turnOptions);
            span?.setAttributes(safeAttributes({
              "forksafe.turn.index": turnIndex,
              "forksafe.turn.mode": outcome.mode,
              "forksafe.turn.success": outcome.success,
              "forksafe.turn.tool_calls": outcome.toolCalls.length,
              "forksafe.session_id": outcome.sessionId,
              "forksafe.vendor_session_id": outcome.vendorRef.id,
              ...tokenAttributes(outcome.tokenUsage),
            }));
            for (const call of outcome.toolCalls) {
              span?.addEvent("runner.tool_call", safeAttributes({
                "forksafe.tool.name": call.name,
                "forksafe.tool.is_error": call.isError,
              }));
            }
            this.options.telemetry?.telemetry.metrics.recordTokens(outcome.tokenUsage);
            return outcome;
          } finally {
            this.options.telemetry?.telemetry.metrics.turnActive(-1);
            this.options.telemetry?.clearTurnContext(lease.attempt.id);
          }
        };
        turn = this.options.telemetry
          ? await this.options.telemetry.telemetry.withSpan("runner.turn", turnAttrs, runTurn, { parent: traceContext })
          : await runTurn();
        turns.push(turn);
        const registrationError = this.options.sessions.takeSessionRegistrationError(sessionId);
        if (registrationError) throw registrationError;
        if (keeper.signal.aborted) return null;
        if (!this.options.sessions.revisionHeadId(sessionId)) revisionState.headRevisionId = checkpoint?.revisionHeadId;
        // A failed live turn (e.g. a denied built-in tool cancelling the turn) is not fatal:
        // the next turn re-anchors the agent on the ForkSafe tools. Fixture/local turns run once.
        if (turn.mode !== "live" || submittedCandidate(turn)) break;
      }
      const projection = this.options.sessions.toAgentSession(sessionId);
      const reportSession = async (span?: Span) => {
        await this.options.source.session?.({ attemptId: lease.attempt.id, epoch: lease.attempt.epoch, session: projection }).catch(() => undefined);
        span?.setAttribute("forksafe.artifacts.count", this.options.telemetry?.artifactCount(lease.attempt.id) ?? 0);
      };
      if (this.options.telemetry) {
        await this.options.telemetry.telemetry.withSpan("runner.artifacts", {}, reportSession, { parent: traceContext });
      } else {
        await reportSession();
      }
    } catch (error) {
      if (keeper.signal.aborted) {
        await this.options.sessions.interrupt(sessionId).catch(() => undefined);
        await this.options.source.usage?.({
          attemptId: lease.attempt.id, epoch: lease.attempt.epoch,
          session: this.options.sessions.toAgentSession(sessionId),
        }).catch(() => undefined);
        await this.log(lease, "lease abandoned", { reason: String(keeper.signal.reason ?? "aborted") }, sessionId);
        return null;
      }
      failure = error instanceof Error ? error.message : String(error);
      infrastructureFailure = !(error instanceof Error && error.name === "BudgetExceededError");
    } finally {
      keeper.stop();
    }
    try {
      assertFence(lease, clock());
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        jobSpan?.setAttribute("forksafe.lease.abort_reason", "stale");
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
      outcome: failure && infrastructureFailure ? "infra_failed" as const
        : turn?.success && !failure ? "succeeded" as const : "failed" as const,
      result: turn ? { ...summarize(turn), turns: turns.length, candidateSubmitted: turns.some(submittedCandidate) } : { error: failure ?? "turn did not produce a result" },
      usage: session.tokenUsage,
      sessions: [{ ...session, turns: turns.length }],
      finishedAtMs: clock(),
    };
    return this.completeWithRetry(lease, payload, clock, sessionId, traceContext, jobSpan);
  }

  private async completeWithRetry(
    lease: Lease,
    payload: CompletionRequest,
    clock: () => number,
    sessionId = "unknown",
    traceContext?: Context,
    jobSpan?: Span,
  ): Promise<CompletionResponse | null> {
    jobSpan?.setAttribute("forksafe.outcome", payload.outcome);
    const backoffs = [250, 500, 1_000];
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)));
    const complete = async (span?: Span): Promise<CompletionResponse | null> => {
      let attempts = 0;
      for (let attempt = 0; attempt <= backoffs.length; attempt += 1) {
        try {
          assertFence(lease, clock());
        } catch (error) {
          if (error instanceof StaleLeaseError) {
            jobSpan?.setAttribute("forksafe.lease.abort_reason", "stale");
            await this.log(lease, "stale result dropped", { reason: error.message }, sessionId);
            return null;
          }
          throw error;
        }
        try {
          attempts += 1;
          const response = await this.options.source.complete(payload);
          span?.setAttributes(safeAttributes({
            "forksafe.completion.accepted": response.accepted,
            "forksafe.completion.attempts": attempts,
          }));
          if (!response.accepted) await this.log(lease, "completion rejected", { reason: response.reason ?? "unknown" }, sessionId);
          return response;
        } catch (error) {
          if (error instanceof FencedError) {
            jobSpan?.setAttribute("forksafe.lease.abort_reason", "stale_epoch");
            await this.log(lease, "stale result dropped", { reason: "stale_epoch" }, sessionId);
            return null;
          }
          if (attempt === backoffs.length) throw error;
          await sleep(backoffs[attempt]!);
        }
      }
      throw new Error("Completion retry loop exited unexpectedly");
    };
    if (this.options.telemetry) {
      return this.options.telemetry.telemetry.withSpan("runner.complete", {
        "forksafe.outcome": payload.outcome,
      }, complete, { parent: traceContext });
    }
    return complete();
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

const CONTINUE_PROMPT = "You have about two turns total. If you have not submitted yet, promptly complete the remaining sequence in one Script: inspect_failure → read_source(task_controller.py) → apply_patch using the returned expected head → run_experiment on a public case → submit_candidate with your best measured revision, even if it does not pass. There is no shell or direct filesystem access. Load deferred schemas with ToolSearch `select:forksafe___<name>`, then call them from Script via `tools.forksafe___<name>(...)`. Report only measured results.";

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
