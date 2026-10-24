import { randomUUID } from "node:crypto";
import type { SessionManager, TurnOutcome } from "@forksafe/agents";
import { buildRepairPrompt, type RepairPromptParams } from "@forksafe/agents";
import type { VendorRef } from "@forksafe/contracts";
import { ActivityLog } from "@forksafe/agents";
import { assertFence, StaleLeaseError } from "./fencing.js";
import { LeaseKeeper } from "./heartbeat.js";
import type { JobSource } from "./job-source.js";
import type { Lease } from "./protocol.js";

export class RunnerExecutor {
  private readonly sessionsByEnvironment = new Map<string, string>();
  constructor(
    private readonly options: {
      sessions: SessionManager;
      source: JobSource;
      log: ActivityLog;
      clock?: () => number;
      beforeJob?: (lease: Lease) => void;
    },
  ) {}

  async execute(lease: Lease): Promise<unknown | null> {
    if (lease.job.kind !== "factory_session") throw new Error(`Unsupported runner job kind: ${lease.job.kind}`);
    if (!lease.job.environmentId) throw new Error("factory_session jobs require environmentId");
    const clock = this.options.clock ?? Date.now;
    this.options.beforeJob?.(lease);
    const key = `${lease.job.investigationId}:${lease.job.environmentId}`;
    let sessionId = this.sessionsByEnvironment.get(key);
    if (!sessionId) {
      const created = await this.options.sessions.createSession({
        investigationId: lease.job.investigationId,
        environmentId: lease.job.environmentId,
      });
      sessionId = created.sessionId;
      this.sessionsByEnvironment.set(key, sessionId);
    }
    const keeper = new LeaseKeeper(lease, this.options.source, clock);
    keeper.start();
    let turn: TurnOutcome | undefined;
    let failure: string | undefined;
    try {
      const payload = lease.job.payload;
      const prompt = typeof payload.prompt === "string"
        ? payload.prompt
        : payload.repair
          ? buildRepairPrompt(payload.repair as RepairPromptParams)
          : "Review the investigation and use the ForkSafe tools to report evidence-backed findings.";
      turn = await this.options.sessions.runTurn(sessionId, prompt, {
        abortSignal: keeper.signal,
        toolContext: {
          attemptId: lease.attempt.id,
          grantId: lease.grant.id,
          epoch: lease.attempt.epoch,
        },
      });
      if (keeper.signal.aborted) return null;
    } catch (error) {
      if (keeper.signal.aborted) {
        await this.options.sessions.interrupt(sessionId).catch(() => undefined);
        await this.log(lease, "lease abandoned", { reason: String(keeper.signal.reason ?? "aborted") });
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
        await this.log(lease, "stale result dropped", { reason: error.message });
        return null;
      }
      throw error;
    }
    const session = this.options.sessions.toAgentSession(sessionId);
    const sessions: VendorRef[] = session.factorySession ? [session.factorySession] : [];
    const payload = {
      operationId: randomUUID(),
      jobId: lease.job.id,
      attemptId: lease.attempt.id,
      grantId: lease.grant.id,
      epoch: lease.attempt.epoch,
      outcome: turn?.success && !failure ? "succeeded" as const : "failed" as const,
      result: turn ? summarize(turn) : { error: failure ?? "turn did not produce a result" },
      usage: session.tokenUsage,
      sessions,
      finishedAtMs: clock(),
    };
    const response = await this.options.source.complete(payload);
    if (!response.accepted) await this.log(lease, "completion rejected", { reason: response.reason ?? "unknown" });
    return response;
  }

  private async log(lease: Lease, summary: string, data: Record<string, unknown>): Promise<void> {
    await this.options.log.record({
      atMs: (this.options.clock ?? Date.now)(),
      investigationId: lease.job.investigationId,
      environmentId: lease.job.environmentId ?? "unknown",
      sessionId: this.sessionsByEnvironment.get(`${lease.job.investigationId}:${lease.job.environmentId}`) ?? "unknown",
      kind: "lifecycle",
      summary,
      data,
    });
  }
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
