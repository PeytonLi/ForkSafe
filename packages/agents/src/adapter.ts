import {
  AutonomyLevel,
  DroidMessageType,
  ToolConfirmationOutcome,
  createSession,
  resumeSession,
  type DroidSession,
  type DroidStreamMessage,
  type SdkMcpServer,
  type ToolInfo,
} from "@factory/droid-sdk/node";
import type { TokenUsage } from "./usage.js";

export type StreamMsg =
  | { type: "assistant"; text: string }
  | { type: "tool_call"; name: string; toolCallId: string }
  | { type: "tool_result"; isError: boolean }
  | { type: "error"; message: string }
  | {
      type: "result";
      sessionId: string;
      durationMs: number;
      tokenUsage: TokenUsage | null;
      text: string;
      turnCount: number;
      success: boolean;
      subtype: string;
      error?: { message: string };
      fixture?: true;
    };

export const DISABLED_BUILTIN_TOOL_IDS = [
  "ApplyPatch",
  "AskUser",
  "ConnectApp",
  "CreateAutomation",
  "DeleteAutomation",
  "DismissHandoffItems",
  "EditAutomation",
  "EndFeatureRun",
  "ExitSpecMode",
  "FetchUrl",
  "GenerateDroid",
  "GenerateImage",
  "ListAutomations",
  "ListAutomationTemplates",
  "Loop",
  "ProposeMission",
  "ReadAutomation",
  "RunAutomation",
  "Skill",
  "StageSettingsChanges",
  "StartMissionRun",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "WaitForScript",
  "WebSearch",
] as const;

export type AdapterSessionOptions = {
  cwd: string;
  modelId?: string;
  autonomyLevel?: AutonomyLevel;
  apiKey?: string;
  mcpServers?: SdkMcpServer[];
  permissionHandler?: (params: unknown) => ToolConfirmationOutcome | Promise<ToolConfirmationOutcome>;
  systemPrompt?: string;
};

export interface AdapterSession {
  vendorId: string;
  enabledToolIds?: string[];
  stream(prompt: string, options?: { abortSignal?: AbortSignal }): AsyncIterable<StreamMsg>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface FactoryAdapter {
  mode: "live" | "fixture";
  createSession(opts: AdapterSessionOptions): Promise<AdapterSession>;
  resumeSession(vendorId: string, opts: AdapterSessionOptions): Promise<AdapterSession>;
}

export class SessionMissingError extends Error {
  constructor(vendorId: string, options?: ErrorOptions) {
    super(`Factory session not found: ${vendorId}`, options);
    this.name = "SessionMissingError";
  }
}

export type ToolInfoLike = Pick<ToolInfo, "id" | "source" | "allowed"> & {
  serverName?: string;
  mcpServerName?: string;
  mcp?: { serverName?: string };
};

export function computeDisabledToolIds(tools: ToolInfoLike[], allowedMcpServer = "forksafe"): string[] {
  return [...new Set(tools
    .filter((tool) => tool.source !== "mcp" || (tool.serverName ?? tool.mcpServerName ?? tool.mcp?.serverName) !== allowedMcpServer)
    .map((tool) => tool.id))];
}

export class ToolSurfaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolSurfaceError";
  }
}

function mapMessage(message: DroidStreamMessage): StreamMsg | null {
  switch (message.type) {
    case DroidMessageType.Assistant:
      return { type: "assistant", text: message.text };
    case DroidMessageType.ToolCall:
      return { type: "tool_call", name: message.name, toolCallId: message.toolUseId };
    case DroidMessageType.ToolResult:
      return { type: "tool_result", isError: message.isError };
    case DroidMessageType.Error:
      return { type: "error", message: message.message };
    case DroidMessageType.Result:
      return {
        type: "result",
        sessionId: message.sessionId,
        durationMs: message.durationMs,
        tokenUsage: message.tokenUsage as TokenUsage | null,
        text: message.text,
        turnCount: message.turnCount,
        success: message.success,
        subtype: message.subtype,
        ...(message.error ? { error: { message: message.error.message } } : {}),
      };
    default:
      return null;
  }
}

function liveSession(session: DroidSession, enabledToolIds: string[]): AdapterSession {
  return {
    vendorId: session.id,
    enabledToolIds,
    async *stream(prompt, options) {
      for await (const message of session.stream(prompt, options as never)) {
        const mapped = mapMessage(message);
        if (mapped) yield mapped;
      }
    },
    async interrupt() { await session.interrupt(); },
    async close() { await session.close(); },
  };
}

export class LiveFactoryAdapter implements FactoryAdapter {
  readonly mode = "live" as const;
  constructor(
    private readonly options: { apiKey?: string; modelId?: string; execPath?: string; autonomyLevel?: AutonomyLevel } = {},
    private readonly sessionApi: { createSession: typeof createSession; resumeSession: typeof resumeSession } = { createSession, resumeSession },
  ) {}

  async createSession(opts: AdapterSessionOptions): Promise<AdapterSession> {
    const create = (disabledToolIds: string[]) => this.sessionApi.createSession({
      cwd: opts.cwd,
      modelId: opts.modelId ?? this.options.modelId ?? process.env.FACTORY_MODEL,
      autonomyLevel: opts.autonomyLevel ?? this.options.autonomyLevel ?? AutonomyLevel.Low,
      disabledToolIds,
      mcpServers: opts.mcpServers,
      permissionHandler: opts.permissionHandler as never,
      systemPrompt: opts.systemPrompt,
      apiKey: opts.apiKey ?? this.options.apiKey,
      execPath: this.options.execPath,
    });
    return this.secureSession(await create([...DISABLED_BUILTIN_TOOL_IDS]), create);
  }

  async resumeSession(vendorId: string, opts: AdapterSessionOptions): Promise<AdapterSession> {
    try {
      const resume = (disabledToolIds: string[]) => this.sessionApi.resumeSession(vendorId, {
        mcpServers: opts.mcpServers,
        permissionHandler: opts.permissionHandler as never,
        disabledToolIds,
        apiKey: opts.apiKey ?? this.options.apiKey,
        execPath: this.options.execPath,
      });
      const session = await resume([...DISABLED_BUILTIN_TOOL_IDS]);
      return await this.secureSession(session, (disabledToolIds) => this.sessionApi.createSession({
        cwd: opts.cwd,
        modelId: opts.modelId ?? this.options.modelId ?? process.env.FACTORY_MODEL,
        autonomyLevel: opts.autonomyLevel ?? this.options.autonomyLevel ?? AutonomyLevel.Low,
        disabledToolIds,
        mcpServers: opts.mcpServers,
        permissionHandler: opts.permissionHandler as never,
        systemPrompt: opts.systemPrompt,
        apiKey: opts.apiKey ?? this.options.apiKey,
        execPath: this.options.execPath,
      }));
    } catch (error) {
      if (error instanceof ToolSurfaceError) throw error;
      if (error instanceof Error && error.name === "SessionNotFoundError") throw new SessionMissingError(vendorId, { cause: error });
      throw error;
    }
  }

  private async secureSession(
    initial: DroidSession,
    recreate: (disabledToolIds: string[]) => Promise<DroidSession>,
  ): Promise<AdapterSession> {
    let session = initial;
    let tools: ToolInfo[];
    try {
      tools = await session.listTools();
    } catch (error) {
      await session.close().catch(() => undefined);
      throw new ToolSurfaceError("Factory tool surface could not be inspected", { cause: error });
    }

    const disabledToolIds = computeDisabledToolIds(tools);
    const restrictedToolIds = [...new Set([...DISABLED_BUILTIN_TOOL_IDS, ...disabledToolIds])];
    const hasEnabledForbiddenTool = tools.some((tool) =>
      tool.allowed && computeDisabledToolIds([tool]).length > 0,
    );
    if (hasEnabledForbiddenTool) {
      if (typeof session.updateSettings === "function") {
        try {
          await session.updateSettings({ disabledToolIds: restrictedToolIds });
        } catch {
          await session.close().catch(() => undefined);
          try {
            session = await recreate(restrictedToolIds);
          } catch (error) {
            throw new ToolSurfaceError("Factory tool restrictions could not be applied", { cause: error });
          }
        }
      } else {
        await session.close().catch(() => undefined);
        try {
          session = await recreate(restrictedToolIds);
        } catch (error) {
          throw new ToolSurfaceError("Factory session could not be recreated with restricted tools", { cause: error });
        }
      }
      try {
        tools = await session.listTools();
      } catch (error) {
        await session.close().catch(() => undefined);
        throw new ToolSurfaceError("Factory tool surface could not be verified", { cause: error });
      }
    }

    const enabledToolIds = tools.filter((tool) => tool.allowed).map((tool) => tool.id);
    if (tools.some((tool) => tool.allowed && computeDisabledToolIds([tool]).length > 0)) {
      await session.close().catch(() => undefined);
      throw new ToolSurfaceError("Factory exposed an enabled tool outside the ForkSafe MCP server");
    }
    return liveSession(session, enabledToolIds);
  }
}

export class FixtureFactoryAdapter implements FactoryAdapter {
  readonly mode = "fixture" as const;
  private sequence = 0;
  private readonly sessions = new Set<string>();

  constructor(private readonly options: { usage?: "known" | "unknown"; gate?: () => Promise<void> } = {}) {}

  async createSession(_opts: AdapterSessionOptions): Promise<AdapterSession> {
    this.sequence += 1;
    const vendorId = `fixture-session-${String(this.sequence).padStart(4, "0")}`;
    this.sessions.add(vendorId);
    return this.fixtureSession(vendorId);
  }

  async resumeSession(vendorId: string, _opts: AdapterSessionOptions): Promise<AdapterSession> {
    if (!this.sessions.has(vendorId)) throw new SessionMissingError(vendorId);
    return this.fixtureSession(vendorId);
  }

  private fixtureSession(vendorId: string): AdapterSession {
    const fixtureOptions = this.options;
    return {
      vendorId,
      async *stream(_prompt, streamOptions) {
        if (streamOptions?.abortSignal?.aborted) throw streamOptions.abortSignal.reason ?? new Error("Aborted");
        await fixtureOptions.gate?.();
        if (streamOptions?.abortSignal?.aborted) throw streamOptions.abortSignal.reason ?? new Error("Aborted");
        yield { type: "assistant", text: "[FIXTURE AGENT] I will inspect the available findings." };
        yield { type: "tool_call", name: "read_findings", toolCallId: "fixture-call-0001" };
        yield { type: "tool_result", isError: false };
        yield {
          type: "result",
          sessionId: vendorId,
          durationMs: 1,
          tokenUsage: fixtureOptions.usage === "unknown" ? null : {
            inputTokens: 12, outputTokens: 8, cacheCreationTokens: 0, cacheReadTokens: 0,
          },
          text: "[FIXTURE AGENT] No findings are recorded. DONE",
          turnCount: 1,
          success: true,
          subtype: "success",
          fixture: true,
        };
      },
      async interrupt() {},
      async close() {},
    };
  }
}
