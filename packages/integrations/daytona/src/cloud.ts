import { Daytona, type Sandbox } from "@daytonaio/sdk";
import type { IntegrationReadiness, VendorRef } from "@forksafe/contracts";
import { daytonaReadiness, redactDaytonaError, type DaytonaConfig } from "./config.js";
import { assertCommandAllowed } from "./policy.js";
import {
  AmbiguousOperationError,
  CapacityError,
  type CommandExecutionResult,
  type CommandHandle,
  type PollCommandResult,
  type SandboxHandle,
  type SandboxLabels,
  type SandboxProvider,
  type SandboxSpec,
} from "./types.js";

const OWNED = { "forksafe.project": "forksafe" };
const LOG_LIMIT = 65_536;

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; statusCode?: number; response?: { status?: number } };
  return value.status === 404 || value.statusCode === 404 || value.response?.status === 404;
}

function handleFromSandbox(sandbox: Sandbox): SandboxHandle {
  return {
    ref: { provider: "daytona", id: sandbox.id },
    state: String(sandbox.state),
    labels: { ...sandbox.labels },
  };
}

export class CloudDaytonaProvider implements SandboxProvider {
  readonly mode = "live" as const;

  constructor(
    private readonly client: Daytona,
    private readonly config: DaytonaConfig,
  ) {}

  async readiness(): Promise<IntegrationReadiness> {
    return daytonaReadiness(this.config);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const existing = await this.findByOperation(spec.operationId);
    if (existing) return existing;
    const owned = await this.listOwned();
    if (Math.max(
      owned.filter((item) => !["stopped", "archived", "deleted"].includes(item.state)).length,
      spec.reservedSandboxCount ?? 0,
    ) >= this.config.maxActiveSandboxes) {
      throw new CapacityError();
    }
    try {
      const created = await this.client.create({
        name: `forksafe-${spec.purpose}-${spec.operationId}`,
        snapshot: spec.snapshot,
        labels: { ...spec.labels, ...OWNED },
        envVars: spec.envVars,
        autoStopInterval: spec.autoStopMinutes,
        autoArchiveInterval: spec.autoArchiveMinutes,
        autoDeleteInterval: spec.autoDeleteMinutes,
      }, { timeout: spec.createTimeoutSec });
      return handleFromSandbox(created);
    } catch {
      const reconciled = await this.findByOperation(spec.operationId).catch(() => null);
      if (reconciled) return reconciled;
      throw new AmbiguousOperationError("create");
    }
  }

  async findByOperation(operationId: string): Promise<SandboxHandle | null> {
    const owned = await this.listOwned({ "forksafe.operation": operationId });
    return owned[0] ?? null;
  }

  async get(ref: VendorRef): Promise<SandboxHandle | null> {
    this.assertRef(ref);
    try {
      const sandbox = await this.client.get(ref.id);
      if (sandbox.labels["forksafe.project"] !== "forksafe") return null;
      return handleFromSandbox(sandbox);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw redactDaytonaError(error);
    }
  }

  async listOwned(filter: Partial<SandboxLabels> = {}): Promise<SandboxHandle[]> {
    const queryLabels = { ...OWNED, ...filter };
    const result: SandboxHandle[] = [];
    try {
      for await (const sandbox of this.client.list({ labels: queryLabels })) {
        if (sandbox.labels["forksafe.project"] !== "forksafe") continue;
        if (Object.entries(filter).some(([key, value]) => sandbox.labels[key] !== value)) continue;
        result.push(handleFromSandbox(sandbox));
      }
      return result;
    } catch (error) {
      throw redactDaytonaError(error);
    }
  }

  async destroy(ref: VendorRef): Promise<{ alreadyGone: boolean }> {
    this.assertRef(ref);
    const sandbox = await this.get(ref);
    if (!sandbox) return { alreadyGone: true };
    if (sandbox.labels["forksafe.project"] !== "forksafe") {
      throw new Error("refusing_to_delete_unowned_sandbox");
    }
    try {
      const fullSandbox = await this.client.get(ref.id);
      await this.client.delete(fullSandbox, 30, true);
      const remaining = await this.get(ref);
      if (remaining) throw new AmbiguousOperationError("terminate");
      return { alreadyGone: false };
    } catch (error) {
      if (error instanceof AmbiguousOperationError) throw error;
      if (isNotFound(error)) return { alreadyGone: true };
      throw new AmbiguousOperationError("terminate");
    }
  }

  async exec(
    ref: VendorRef,
    options: { command: string; cwd?: string; env?: Record<string, string>; timeoutSec: number },
  ): Promise<CommandExecutionResult> {
    const sandbox = await this.requireSandbox(ref);
    assertCommandAllowed(sandbox.labels["forksafe.purpose"] as SandboxSpec["purpose"], options.command, options.cwd);
    try {
      const result = await sandbox.process.executeCommand(options.command, options.cwd, options.env, options.timeoutSec);
      const output = result.result ?? "";
      const bytes = Buffer.from(output);
      return {
        exitCode: result.exitCode ?? 1,
        output: bytes.subarray(Math.max(0, bytes.length - LOG_LIMIT)).toString("utf8"),
        truncated: bytes.length > LOG_LIMIT,
      };
    } catch (error) {
      throw redactDaytonaError(error);
    }
  }

  async startCommand(
    ref: VendorRef,
    options: { command: string; cwd?: string; env?: Record<string, string> },
  ): Promise<CommandHandle> {
    const sandbox = await this.requireSandbox(ref);
    assertCommandAllowed(sandbox.labels["forksafe.purpose"] as SandboxSpec["purpose"], options.command, options.cwd);
    const sessionId = `forksafe-${sandbox.labels["forksafe.operation"]}`;
    try {
      await sandbox.process.createSession(sessionId);
    } catch {
      try {
        await sandbox.process.getSession(sessionId);
      } catch (error) {
        throw redactDaytonaError(error);
      }
    }
    try {
      const envPairs = Object.entries(options.env ?? {}).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("command_environment_invalid");
        return `${key}=${shellQuote(value)}`;
      });
      const command = [
        ...(options.cwd ? [`cd ${shellQuote(options.cwd)} &&`] : []),
        ...(envPairs.length ? [`env ${envPairs.join(" ")} `] : []),
        assertCommandAllowed(sandbox.labels["forksafe.purpose"] as SandboxSpec["purpose"], options.command)
          .map(shellQuote).join(" "),
      ].join(" ");
      const response = await sandbox.process.executeSessionCommand(sessionId, {
        command,
        runAsync: true,
        suppressInputEcho: true,
      });
      if (!response.cmdId) throw new Error("daytona_command_id_missing");
      return { sessionId, commandId: response.cmdId };
    } catch (error) {
      throw redactDaytonaError(error);
    }
  }

  async pollCommand(
    ref: VendorRef,
    handle: CommandHandle,
    options: { maxBytes: number },
  ): Promise<PollCommandResult> {
    const sandbox = await this.requireSandbox(ref);
    const maxBytes = Math.max(0, Math.min(options.maxBytes, LOG_LIMIT));
    try {
      const command = await sandbox.process.getSessionCommand(handle.sessionId, handle.commandId);
      const logs = await sandbox.process.getSessionCommandLogs(handle.sessionId, handle.commandId);
      const output = logs.output ?? logs.stdout ?? "";
      const bytes = Buffer.from(output);
      return {
        done: command.exitCode !== undefined,
        ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
        logs: bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8"),
        truncated: bytes.length > maxBytes,
      };
    } catch (error) {
      throw redactDaytonaError(error);
    }
  }

  async uploadFile(ref: VendorRef, remotePath: string, bytes: Uint8Array): Promise<void> {
    const sandbox = await this.requireSandbox(ref);
    try {
      await sandbox.fs.uploadFile(Buffer.from(bytes), remotePath);
    } catch (error) {
      throw redactDaytonaError(error);
    }
  }

  async downloadFile(ref: VendorRef, remotePath: string): Promise<Uint8Array> {
    const sandbox = await this.requireSandbox(ref);
    try {
      const bytes = await sandbox.fs.downloadFile(remotePath);
      return new Uint8Array(bytes);
    } catch (error) {
      throw redactDaytonaError(error);
    }
  }

  private async requireSandbox(ref: VendorRef): Promise<Sandbox> {
    this.assertRef(ref);
    const sandbox = await this.client.get(ref.id);
    if (sandbox.labels["forksafe.project"] !== "forksafe") throw new Error("sandbox_not_owned");
    return sandbox;
  }

  private assertRef(ref: VendorRef): void {
    if (ref.provider !== "daytona") throw new Error("sandbox_provider_mismatch");
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type { Daytona };
