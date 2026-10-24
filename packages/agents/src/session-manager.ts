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
import { ActivityLog } from "./activity-log.js";
import type { AdapterSession, FactoryAdapter, StreamMsg } from "./adapter.js";
import { SessionMissingError } from "./adapter.js";
import { BudgetExceededError, UsageLedger, type TokenUsage } from "./usage.js";

export class SessionCapError extends Error {}
export class TurnInProgressError extends Error {}

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
  toolBackend: ForkSafeToolBackend;
  log: ActivityLog;
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
  private readonly sessionsPerEnvironment: number;
  private readonly maxActiveTurns: number;
  private activeTurns = 0;
  private waiters: { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal }[] = [];

  constructor(private readonly options: SessionManagerOptions) {
    this.sessionsPerEnvironment = options.sessionsPerEnvironment ?? 2;
    this.maxActiveTurns = options.maxActiveTurns ?? 4;
    if (this.sessionsPerEnvironment > 3) throw new RangeError("sessionsPerEnvironment cannot exceed 3");
  }

  async createSession(input: { investigationId: string; environmentId: string }): Promise<{ sessionId: string; vendorRef: VendorRef }> {
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
    const id = crypto.randomUUID();
    const toolContext: ToolCallContext = {
      investigationId, environmentId, sessionId: id,
      attemptId: crypto.randomUUID(), grantId: crypto.randomUUID(), epoch: 0,
    };
    const policy: PermissionPolicy = { workspaceRoot: cwd, mcpServerName: "forksafe", allowedMcpTools: ["read_findings", "request_evidence", "run_experiment", "submit_candidate", "write_finding"] };
    const mcpServer = createForkSafeMcpServer(
      this.options.toolBackend,
      toolContext,
      this.options.log,
    );
    const adapterSession = await this.options.adapter.createSession({
      cwd,
      mcpServers: [mcpServer],
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
            allowed: decision.allowed,
            reasons: decision.reasons,
          },
        });
        return decision.outcome;
      },
    });
    this.sessions.set(id, {
      id, investigationId, environmentId, cwd, adapterSession,
      state: "created", createdAtMs: Date.now(), active: false, toolContext,
    });
    await this.lifecycle(id, "session created");
    return { sessionId: id, vendorRef: this.vendorRef(adapterSession.vendorId) };
  }

  async runTurn(
    sessionId: string,
    prompt: string,
    options: { abortSignal?: AbortSignal; toolContext?: Partial<Pick<ToolCallContext, "attemptId" | "grantId" | "epoch">> } = {},
  ): Promise<TurnOutcome> {
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
    let started = false;
    const startedAt = Date.now();
    const toolCalls: TurnOutcome["toolCalls"] = [];
    let text = "";
    let finalResult: Extract<StreamMsg, { type: "result" }> | undefined;
    try {
      await this.acquire(options.abortSignal);
      acquired = true;
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
      return {
        sessionId,
        vendorRef: this.vendorRef(session.adapterSession.vendorId),
        mode: this.options.adapter.mode,
        success: finalResult?.success ?? false,
        text: text.slice(0, 2000),
        toolCalls,
        tokenUsage,
        durationMs: finalResult?.durationMs ?? Date.now() - startedAt,
      };
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
      session.active = false;
    }
  }

  async resume(sessionId: string): Promise<{ sessionId: string; vendorRef: VendorRef }> {
    const session = this.requireSession(sessionId);
    try {
      session.adapterSession = await this.options.adapter.resumeSession(session.adapterSession.vendorId, {
        cwd: session.cwd,
      });
      session.state = "idle";
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

  toAgentSession(sessionId: string): AgentSessionType {
    const session = this.requireSession(sessionId);
    return AgentSession.parse({
      id: session.id,
      investigationId: session.investigationId,
      environmentId: session.environmentId,
      state: session.state,
      factorySession: this.vendorRef(session.adapterSession.vendorId),
      mode: this.options.adapter.mode,
      tokenUsage: this.options.ledger.sessionUsage(sessionId),
      createdAtMs: session.createdAtMs,
      ...(session.closedAtMs !== undefined ? { closedAtMs: session.closedAtMs } : {}),
    });
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
      const waiter = { resolve: () => { cleanup(); this.activeTurns += 1; resolvePromise(); }, reject, signal };
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

  private release(): void {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.activeTurns -= 1;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
