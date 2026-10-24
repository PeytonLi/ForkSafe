import type { IntegrationReadiness, VendorRef } from "@forksafe/contracts";

export type SandboxPurpose = "runner" | "execution" | "evaluator" | "bridge";

export type SandboxLabels = {
  "forksafe.project": "forksafe";
  "forksafe.operation": string;
  "forksafe.purpose": SandboxPurpose;
  "forksafe.investigation": string;
  "forksafe.environment"?: string;
  "forksafe.attempt"?: string;
  "forksafe.run"?: string;
};

export type DaytonaResources = {
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
};

export type SandboxSpec = {
  operationId: string;
  reservedSandboxCount?: number;
  purpose: SandboxPurpose;
  labels: SandboxLabels;
  snapshot?: string;
  image?: string;
  resources: DaytonaResources;
  autoStopMinutes: number;
  autoArchiveMinutes?: number;
  autoDeleteMinutes: number;
  envVars?: Record<string, string>;
  createTimeoutSec?: number;
};

export type SandboxHandle = {
  ref: VendorRef;
  state: string;
  labels: Record<string, string>;
};

export type CommandHandle = {
  sessionId: string;
  commandId: string;
};

export type CommandExecutionResult = {
  exitCode: number;
  output: string;
  truncated: boolean;
};

export type PollCommandResult = {
  done: boolean;
  exitCode?: number;
  logs: string;
  truncated: boolean;
};

export class CapacityError extends Error {
  constructor() {
    super("daytona_capacity_exhausted");
    this.name = "CapacityError";
  }
}

export class AmbiguousOperationError extends Error {
  constructor(operation: "create" | "terminate") {
    super(`daytona_${operation}_ambiguous`);
    this.name = "AmbiguousOperationError";
  }
}

export class CommandRejectedError extends Error {
  constructor(reason: string) {
    super(`command_rejected:${reason}`);
    this.name = "CommandRejectedError";
  }
}

export class BlockedError extends Error {
  constructor() {
    super("daytona_cloud_mode_requires_api_key");
    this.name = "BlockedError";
  }
}

export interface SandboxProvider {
  readonly mode: "live" | "local";
  readiness(): Promise<IntegrationReadiness>;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  findByOperation(operationId: string): Promise<SandboxHandle | null>;
  get(ref: VendorRef): Promise<SandboxHandle | null>;
  listOwned(filter?: Partial<SandboxLabels>): Promise<SandboxHandle[]>;
  destroy(ref: VendorRef): Promise<{ alreadyGone: boolean }>;
  exec(
    ref: VendorRef,
    options: { command: string; cwd?: string; env?: Record<string, string>; timeoutSec: number },
  ): Promise<CommandExecutionResult>;
  startCommand(
    ref: VendorRef,
    options: { command: string; cwd?: string; env?: Record<string, string> },
  ): Promise<CommandHandle>;
  pollCommand(
    ref: VendorRef,
    handle: CommandHandle,
    options: { maxBytes: number },
  ): Promise<PollCommandResult>;
  uploadFile(ref: VendorRef, remotePath: string, bytes: Uint8Array): Promise<void>;
  downloadFile(ref: VendorRef, remotePath: string): Promise<Uint8Array>;
}
