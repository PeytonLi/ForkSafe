import { mkdir } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import {
  AgentSession,
  type AgentSession as AgentSessionType,
  type VendorRef,
} from "@forksafe/contracts";
import {
  decidePermission,
  type PermissionParams,
  type PermissionPolicy,
} from "./permissions.js";
import {
  createForkSafeMcpServer,
  type ForkSafeToolBackend,
  type ToolCallContext,
} from "./tools.js";
import { REPAIR_AGENT_SYSTEM_PROMPT } from "./prompts.js";
import { ActivityLog } from "./activity-log.js";
import type { AdapterSession, FactoryAdapter, StreamMsg } from "./adapter.js";
import { SessionMissingError } from "./adapter.js";
import { BudgetExceededError, UsageLedger, type TokenUsage } from "./usage.js";

export class SessionCapError extends Error {}
export class TurnInProgressError extends Error {}
export class SessionRegistrationError extends Error {}

export type TurnOutcome = {
  sessionId: string;
  vendorRef: VendorRef;
  mode: "live" | "fixture";
  success: boolean;
  text: string;
  toolCalls: { name: string; toolCallId: string; isError: boolean }[];
  tokenUsage: TokenUsage | null;
  durationMs: number;
};

export type SessionManagerOptions = {
  adapter: FactoryAdapter;
  ledger: UsageLedger;
  workspaceRoot: string;
  sessionsPerEnvironment?: number;
  maxActiveTurns?: number;
  turnGate?: {
    acquire(input: { attemptId: string; epoch: number; grantId: string; sessionId: string; turnKey: string }, signal?: AbortSignal): Promise<boolean>;
    tryAcquire(input: { attemptId: string; epoch: number; grantId: string; sessionId: string; turnKey: string }): Promise<boolean>;
    release(input: { attemptId: string; epoch: number; grantId: string; sessionId: string; turnKey: string }): Promise<void>;
  };
  toolBackend: ForkSafeToolBackend;
  log: ActivityLog;
  onSessionReady?: (input: { attemptId: string; epoch: number; session: AgentSessionType }) => Promise<unknown>;
  onTurnComplete?: (input: {
    investigationId: string; environmentId: string; sessionId: string; vendorSessionId: string;
    attemptId: string; epoch: number; jobId: string; turnIndex: number; parentSessionId?: string;
    role: "primary" | "subtask"; revisionHeadId?: string; tokenUsage: TokenUsage | null;
  }) => Promise<void>;
};

function permissionAuditDetails(params: PermissionParams): Record<string, unknown>[] {
  return params.toolUses.map((use) => {
    const details = use.details;
    const calls = Array.isArray(details.calls)
      ? details.calls.flatMap((call) => {
        if (typeof call !== "object" || call === null || Array.isArray(call)) return [];
        const nested = call as Record<string, unknown>;
        const confirmation = nested.confirmation;
        if (typeof nested.toolName !== "string" || typeof confirmation !== "object" || confirmation === null || Array.isArray(confirmation)) return [];
        const type = (confirmation as Record<string, unknown>).type;
        return typeof type === "string" ? [{ toolName: nested.toolName, type }] : [];
      })
      : undefined;
    const toolName = typeof details.toolName === "string" ? details.toolName : use.name;
    const serverName = details.serverName ?? details.server;
    return {
      type: typeof details.type === "string" ? details.type : use.confirmationType,
      ...(typeof toolName === "string" ? { toolName } : {}),
      ...(typeof serverName === "string" ? { serverName } : {}),
      ...(typeof details.actualToolName === "string" ? { actualToolName: details.actualToolName } : {}),
      ...(calls ? { calls } : {}),
    };
  });
}

type RunTurnOptions = {
  abortSignal?: AbortSignal;
  nonBlocking?: boolean;
  toolContext?: Partial<Pick<ToolCallContext, "attemptId" | "grantId" | "epoch" | "turnBudget" | "revisionState" | "jobId" | "turnIndex" | "parentSessionId" | "role">>;
};

type ManagedSession = {
  id: string;
  investigationId: string;
  environmentId: string;
  cwd: string;
  adapterSession: AdapterSession;
  state: AgentSessionType["state"];
  createdAtMs: number;
  closedAtMs?: number;
  replacesSessionId?: string;
  active: boolean;
  toolContext: ToolCallContext;
};

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly sessionRegistrationErrors = new Map<string, SessionRegistrationError>();
  private readonly sessionsPerEnvironment: number;
  private readonly maxActiveTurns: number;
  private activeTurns = 0;
  private waiters: { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal }[] = [];

  constructor(private readonly options: SessionManagerOptions) {
    this.sessionsPerEnvironment = options.sessionsPerEnvironment ?? 2;
    this.maxActiveTurns = options.maxActiveTurns ?? 4;
    if (this.sessionsPerEnvironment > 3) throw new RangeError("sessionsPerEnvironment cannot exceed 3");
  }

  async createSession(input: {
    investigationId: string; environmentId: string; vendorSessionId?: string; sessionId?: string;
  }): Promise<{ sessionId: string; vendorRef: VendorRef }> {
    const { investigationId, environmentId } = input;
    if (!isUuid(investigationId) || !isUuid(environmentId)) throw new TypeError("Investigation and environment IDs must be UUIDs");
    const open = [...this.sessions.values()].filter((session) =>
      session.investigationId === investigationId && session.environmentId === environmentId && session.state !== "closed",
    ).length;
    if (open >= this.sessionsPerEnvironment) throw new SessionCapError("Environment session cap reached");
    const cwd = resolve(this.options.workspaceRoot, investigationId, environmentId);
    const rel = relative(resolve(this.options.workspaceRoot), cwd);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError("Workspace path escaped root");
    await mkdir(cwd, { recursive: true });
    let id = input.sessionId ?? crypto.randomUUID();
    let replacesSessionId: string | undefined;
    const toolContext: ToolCallContext = {
      investigationId, environmentId, sessionId: id,
      attemptId: crypto.randomUUID(), grantId: crypto.randomUUID(), epoch: 0,
      revisionState: {},
    };
    const policy: PermissionPolicy = { workspaceRoot: cwd, mcpServerName: "forksafe", allowedMcpTools: ["inspect_failure", "read_source", "apply_patch", "fork_candidate", "request_subtask", "read_findings", "request_evidence", "run_experiment", "propose_controller_revision", "submit_candidate", "write_finding"] };
    const mcpServer = createForkSafeMcpServer(
      this.options.toolBackend,
      toolContext,
      this.options.log,
    );
    const adapterOptions = {
      cwd,
      mcpServers: [mcpServer],
      systemPrompt: REPAIR_AGENT_SYSTEM_PROMPT,
      permissionHandler: async (params: unknown) => {
        const decision = decidePermission(params as PermissionParams, policy);
        await this.options.log.record({
          atMs: Date.now(),
          investigationId,
          environmentId,
          sessionId: id,
          kind: "permission",
          summary: decision.allowed ? "permission allowed" : "permission denied",
          data: {
            toolNames: (params as PermissionParams).toolUses.map((use) => use.name ?? use.confirmationType),
            details: permissionAuditDetails(params as PermissionParams),
            allowed: decision.allowed,
            reasons: decision.reasons,
          },
        });
        return decision.outcome;
      },
    };
    let adapterSession: AdapterSession;
    if (input.vendorSessionId) {
      try {
        adapterSession = await this.options.adapter.resumeSession(input.vendorSessionId, adapterOptions);
      } catch (error) {
        if (!(error instanceof SessionMissingError)) throw error;
        replacesSessionId = input.sessionId ?? id;
        id = crypto.randomUUID();
        adapterSession = await this.options.adapter.createSession(adapterOptions);
      }
    } else {
      adapterSession = await this.options.adapter.createSession(adapterOptions);
    }
    toolContext.sessionId = id;
    this.sessions.set(id, {
      id, investigationId, environmentId, cwd, adapterSession,
      state: "created", createdAtMs: Date.now(), active: false, toolContext, ...(replacesSessionId ? { replacesSessionId } : {}),
    });
    await this.options.log.record({
      atMs: Date.now(), investigationId, environmentId, sessionId: id,
      kind: "lifecycle", summary: "enabled tools",
      data: { toolIds: adapterSession.enabledToolIds ?? [] },
    });
    await this.lifecycle(id, "session created");
    return { sessionId: id, vendorRef: this.vendorRef(adapterSession.vendorId) };
  }

  async resumeFromCheckpoint(input: {
    investigationId: string; environmentId: string; sessionId: string; vendorSessionId: string;
  }): Promise<{ sessionId: string; vendorRef: VendorRef }> {
    return this.createSession(input);
  }

  revisionHeadId(sessionId: string): string | undefined {
    return this.requireSession(sessionId).toolContext.revisionState?.headRevisionId;
  }

  async runTurn(
    sessionId: string,
    prompt: string,
    options: RunTurnOptions & { nonBlocking: true },
  ): Promise<TurnOutcome | null>;
  async runTurn(sessionId: string, prompt: string, options?: RunTurnOptions): Promise<TurnOutcome>;
  async runTurn(
    sessionId: string,
    prompt: string,
    options: RunTurnOptions = {},
  ): Promise<TurnOutcome | null> {
    const session = this.requireSession(sessionId);
    if (session.active) throw new TurnInProgressError("A turn is already active for this session");
    session.active = true;
    Object.assign(session.toolContext, options.toolContext ?? {});
    let reservation: string;
    try {
      reservation = this.options.ledger.reserve(session.id);
    } catch (error) {
      session.active = false;
      if (error instanceof BudgetExceededError) session.state = "budget_exhausted";
      throw error;
    }
    let acquired = false;
    let gateAcquired = false;
    let started = false;
    const startedAt = Date.now();
    const toolCalls: TurnOutcome["toolCalls"] = [];
    let text = "";
    let finalResult: Extract<StreamMsg, { type: "result" }> | undefined;
    const context = session.toolContext;
    const gateInput = context.attemptId && context.grantId && context.epoch !== undefined && context.turnIndex !== undefined
      ? {
        attemptId: context.attemptId, epoch: context.epoch, grantId: context.grantId,
        sessionId: session.id, turnKey: `${context.attemptId}:${session.id}:${context.turnIndex}`,
      }
      : undefined;
    const releaseGate = async () => {
      if (!gateAcquired || !this.options.turnGate || !gateInput) return;
      gateAcquired = false;
      await Promise.resolve()
        .then(() => this.options.turnGate!.release(gateInput))
        .catch(() => undefined);
    };
    try {
      if (this.options.turnGate && gateInput) {
        gateAcquired = options.nonBlocking
          ? await this.options.turnGate.tryAcquire(gateInput)
          : await this.options.turnGate.acquire(gateInput, options.abortSignal);
        if (!gateAcquired) {
          this.options.ledger.release(reservation);
          reservation = "";
          return null;
        }
      }
      if (options.nonBlocking) {
        acquired = this.tryAcquire();
        if (!acquired) {
          await releaseGate();
          this.options.ledger.release(reservation);
          reservation = "";
          return null;
        }
      } else {
        await this.acquire(options.abortSignal);
        acquired = true;
      }
      session.state = "streaming";
      started = true;
      for await (const message of session.adapterSession.stream(prompt, { abortSignal: options.abortSignal })) {
        if (message.type === "assistant") {
          text += message.text;
          await this.logMessage(session, "assistant", message.text);
        } else if (message.type === "tool_call") {
          toolCalls.push({ name: message.name, toolCallId: message.toolCallId, isError: false });
          await this.logMessage(session, "tool_call", message.name);
        } else if (message.type === "tool_result") {
          const call = toolCalls.at(-1);
          if (call) call.isError = message.isError;
          await this.logMessage(session, "tool_result", message.isError ? "error" : "ok");
        } else if (message.type === "error") {
          await this.logMessage(session, "error", message.message);
        } else if (message.type === "result") finalResult = message;
      }
      const tokenUsage = finalResult?.tokenUsage ?? null;
      this.options.ledger.settle(reservation, tokenUsage);
      reservation = "";
      session.state = finalResult?.success ? "idle" : "error";
      await this.logMessage(session, "usage", tokenUsage ? "usage recorded" : "usage unknown");
      const outcome = {
        sessionId,
        vendorRef: this.vendorRef(session.adapterSession.vendorId),
        mode: this.options.adapter.mode,
        success: finalResult?.success ?? false,
        text: text.slice(0, 2000),
        toolCalls,
        tokenUsage,
        durationMs: finalResult?.durationMs ?? Date.now() - startedAt,
      };
      if (context.jobId && context.turnIndex !== undefined) {
        await this.options.onTurnComplete?.({
          investigationId: session.investigationId, environmentId: session.environmentId,
          sessionId: session.id, vendorSessionId: session.adapterSession.vendorId,
          attemptId: context.attemptId, epoch: context.epoch, jobId: context.jobId,
          turnIndex: context.turnIndex,
          ...((context.parentSessionId ?? session.replacesSessionId) ? { parentSessionId: context.parentSessionId ?? session.replacesSessionId } : {}),
          role: context.role ?? "primary",
          ...(context.revisionState?.headRevisionId ? { revisionHeadId: context.revisionState.headRevisionId } : {}),
          tokenUsage,
        }).catch(() => undefined);
      }
      return outcome;
    } catch (error) {
      session.state = "error";
      if (reservation) {
        if (started) this.options.ledger.settle(reservation, null);
        else this.options.ledger.release(reservation);
      }
      await this.logMessage(session, "error", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (acquired) this.release();
      await releaseGate();
      session.active = false;
    }
  }

  async registerSession(
    sessionId: string,
    context: Pick<ToolCallContext, "attemptId" | "grantId" | "epoch" | "jobId">,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    Object.assign(session.toolContext, context);
    try {
      const result = await this.options.onSessionReady?.({
        attemptId: context.attemptId,
        epoch: context.epoch,
        session: this.toAgentSession(sessionId),
      });
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        throw new Error("session registration was rejected");
      }
    } catch (error) {
      throw new SessionRegistrationError(
        `session registration failed: ${error instanceof Error ? error.message : "unknown error"}`,
        { cause: error },
      );
    }
  }

  takeSessionRegistrationError(sessionId: string): SessionRegistrationError | undefined {
    const error = this.sessionRegistrationErrors.get(sessionId);
    this.sessionRegistrationErrors.delete(sessionId);
    return error;
  }

  async runSubtask(input: { prompt: string; purpose: string }, parentContext: ToolCallContext): Promise<Record<string, unknown>> {
    const turnBudget = parentContext.turnBudget;
    if (!turnBudget || turnBudget.used >= turnBudget.max) return { status: "retry_later", reason: "turn_cap" };
    turnBudget.used += 1;
    let child: { sessionId: string; vendorRef: VendorRef };
    try {
      child = await this.createSession({
        investigationId: parentContext.investigationId,
        environmentId: parentContext.environmentId,
      });
    } catch (error) {
      turnBudget.used -= 1;
      return { status: "rejected", reason: error instanceof SessionCapError ? "session_cap" : "subtask_unavailable" };
    }
    try {
      try {
        await this.registerSession(child.sessionId, {
          attemptId: parentContext.attemptId,
          grantId: parentContext.grantId,
          epoch: parentContext.epoch,
          jobId: parentContext.jobId,
        });
      } catch (error) {
        if (!(error instanceof SessionRegistrationError)) throw error;
        this.sessionRegistrationErrors.set(parentContext.sessionId, error);
        return { status: "rejected", reason: "session_registration_failed" };
      }
      const turn = await this.runTurn(child.sessionId, input.prompt, {
        nonBlocking: true,
        toolContext: {
          attemptId: parentContext.attemptId, grantId: parentContext.grantId,
          epoch: parentContext.epoch, turnBudget, revisionState: parentContext.revisionState,
          jobId: parentContext.jobId, turnIndex: turnBudget.used - 1,
          parentSessionId: parentContext.sessionId,
          role: "subtask",
        },
      });
      if (!turn) {
        turnBudget.used -= 1;
        return { status: "retry_later", reason: "turn_cap" };
      }
      return {
        status: turn.success ? "completed" : "failed",
        text: turn.text.slice(0, 2000),
        toolCalls: turn.toolCalls,
        tokenUsage: turn.tokenUsage,
      };
    } finally {
      await this.close(child.sessionId);
    }
  }

  async resume(sessionId: string): Promise<{ sessionId: string; vendorRef: VendorRef }> {
    const session = this.requireSession(sessionId);
    try {
      session.adapterSession = await this.options.adapter.resumeSession(session.adapterSession.vendorId, {
        cwd: session.cwd,
      });
      session.state = "idle";
      await this.options.log.record({
        atMs: Date.now(), investigationId: session.investigationId, environmentId: session.environmentId, sessionId,
        kind: "lifecycle", summary: "enabled tools",
        data: { toolIds: session.adapterSession.enabledToolIds ?? [] },
      });
      return { sessionId, vendorRef: this.vendorRef(session.adapterSession.vendorId) };
    } catch (error) {
      if (!(error instanceof SessionMissingError)) throw error;
      session.state = "error";
      const replacement = await this.createSession({ investigationId: session.investigationId, environmentId: session.environmentId });
      this.requireSession(replacement.sessionId).replacesSessionId = sessionId;
      await this.lifecycle(replacement.sessionId, `replacement for ${sessionId}`);
      return replacement;
    }
  }

  async close(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.state === "closed") return;
    await session.adapterSession.close();
    session.state = "closed";
    session.closedAtMs = Date.now();
    await this.lifecycle(sessionId, "session closed");
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.adapterSession.interrupt();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].filter((session) => session.state !== "closed").map((session) => this.close(session.id)));
  }

  toAgentSession(sessionId: string): AgentSessionType & { unknownTurns: number; partialTurns: number } {
    const session = this.requireSession(sessionId);
    return {
      ...AgentSession.parse({
      id: session.id,
      investigationId: session.investigationId,
      environmentId: session.environmentId,
      state: session.state,
      factorySession: this.vendorRef(session.adapterSession.vendorId),
      mode: this.options.adapter.mode,
      tokenUsage: this.options.ledger.sessionUsage(sessionId),
      createdAtMs: session.createdAtMs,
      ...(session.closedAtMs !== undefined ? { closedAtMs: session.closedAtMs } : {}),
      }),
      ...this.options.ledger.sessionUsageCounts(sessionId),
    };
  }

  replacesSessionId(sessionId: string): string | undefined {
    return this.requireSession(sessionId).replacesSessionId;
  }

  idleSessionFor(investigationId: string, environmentId: string): string | undefined {
    return [...this.sessions.values()].find((session) =>
      session.investigationId === investigationId
      && session.environmentId === environmentId
      && !session.active
      && (session.state === "created" || session.state === "idle"),
    )?.id;
  }

  private requireSession(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session ${id}`);
    return session;
  }

  private vendorRef(vendorId: string): VendorRef {
    return { provider: this.options.adapter.mode === "live" ? "factory" : "local", id: vendorId };
  }

  private async lifecycle(sessionId: string, summary: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.logMessage(session, "lifecycle", summary);
  }

  private async logMessage(session: ManagedSession, kind: "assistant" | "tool_call" | "tool_result" | "error" | "usage" | "lifecycle", summary: string): Promise<void> {
    await this.options.log.record({
      atMs: Date.now(), investigationId: session.investigationId,
      environmentId: session.environmentId, sessionId: session.id, kind, summary,
    });
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
    if (this.activeTurns < this.maxActiveTurns) {
      this.activeTurns += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise, reject) => {
      const waiter = { resolve: () => { cleanup(); resolvePromise(); }, reject, signal };
      const abort = () => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        cleanup();
        reject(signal?.reason ?? new Error("Aborted"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private tryAcquire(): boolean {
    if (this.activeTurns >= this.maxActiveTurns) return false;
    this.activeTurns += 1;
    return true;
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.activeTurns -= 1;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
