import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IntegrationReadiness, VendorRef } from "@forksafe/contracts";
import { daytonaReadiness, type DaytonaConfig } from "./config.js";
import { assertCommandAllowed } from "./policy.js";
import type {
  CommandExecutionResult,
  CommandHandle,
  PollCommandResult,
  SandboxHandle,
  SandboxLabels,
  SandboxProvider,
  SandboxSpec,
} from "./types.js";

type ExecResult = { stdout: string; stderr: string };
type ExecFile = (file: string, args: string[], options?: Record<string, unknown>) => Promise<ExecResult>;
const defaultExecFile: ExecFile = promisify(nodeExecFile) as unknown as ExecFile;

function parseLabels(value: string | undefined): Record<string, string> {
  return Object.fromEntries((value ?? "").split(",").filter(Boolean).map((label) => {
    const [key, ...rest] = label.split("=");
    return [key!, rest.join("=")];
  }));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class LocalDockerProvider implements SandboxProvider {
  readonly mode = "local" as const;

  constructor(
    private readonly config: DaytonaConfig,
    private readonly execFile: ExecFile = defaultExecFile,
  ) {}

  async readiness(): Promise<IntegrationReadiness> {
    return daytonaReadiness(this.config);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const existing = await this.findByOperation(spec.operationId);
    if (existing) return existing;
    const args = [
      "run", "-d", "--name", `forksafe-${spec.operationId}`,
      "--cpus", String(spec.resources.cpu),
      "--memory", `${spec.resources.memoryGiB}g`,
      "--label", "forksafe.project=forksafe",
      ...Object.entries(spec.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...Object.entries(spec.envVars ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      spec.image ?? this.config.localImage,
      "sleep", "infinity",
    ];
    const { stdout } = await this.runDocker(args);
    const id = stdout.trim();
    if (!id) throw new Error("docker_container_id_missing");
    return {
      ref: { provider: "local", id },
      state: "running",
      labels: { ...spec.labels, "forksafe.project": "forksafe" },
    };
  }

  async findByOperation(operationId: string): Promise<SandboxHandle | null> {
    const owned = await this.listOwned({ "forksafe.operation": operationId });
    return owned[0] ?? null;
  }

  async get(ref: VendorRef): Promise<SandboxHandle | null> {
    this.assertRef(ref);
    try {
      const { stdout } = await this.runDocker(["inspect", "--format", "{{json .}}", ref.id]);
      const item = JSON.parse(stdout) as {
        Id: string; State: { Status: string }; Config: { Labels: Record<string, string> };
      };
      if (item.Config.Labels["forksafe.project"] !== "forksafe") return null;
      return { ref, state: item.State.Status, labels: item.Config.Labels };
    } catch {
      return null;
    }
  }

  async listOwned(filter: Partial<SandboxLabels> = {}): Promise<SandboxHandle[]> {
    const { stdout } = await this.runDocker([
      "ps", "-a", "--filter", "label=forksafe.project=forksafe", "--format", "{{json .}}",
    ]);
    const rows: SandboxHandle[] = [];
    for (const line of stdout.split("\n").filter(Boolean)) {
      const item = JSON.parse(line) as { ID: string; State: string; Labels?: string };
      const labels = parseLabels(item.Labels);
      if (Object.entries(filter).some(([key, value]) => labels[key] !== value)) continue;
      rows.push({ ref: { provider: "local", id: item.ID }, state: item.State, labels });
    }
    return rows;
  }

  async destroy(ref: VendorRef): Promise<{ alreadyGone: boolean }> {
    this.assertRef(ref);
    const sandbox = await this.get(ref);
    if (!sandbox) return { alreadyGone: true };
    if (sandbox.labels["forksafe.project"] !== "forksafe") throw new Error("refusing_to_delete_unowned_sandbox");
    await this.runDocker(["rm", "-f", ref.id]);
    return { alreadyGone: false };
  }

  async exec(
    ref: VendorRef,
    options: { command: string; cwd?: string; env?: Record<string, string>; timeoutSec: number },
  ): Promise<CommandExecutionResult> {
    const sandbox = await this.requireSandbox(ref);
    const argv = assertCommandAllowed(sandbox.labels["forksafe.purpose"] as SandboxSpec["purpose"], options.command, options.cwd);
    const args = ["exec"];
    if (options.cwd) args.push("--workdir", options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("--env", `${key}=${value}`);
    args.push(ref.id, ...argv);
    try {
      const result = await this.execFile("docker", args, { timeout: options.timeoutSec * 1_000, maxBuffer: 65_536 });
      return { exitCode: 0, output: result.stdout.slice(-65_536), truncated: result.stdout.length > 65_536 };
    } catch (error) {
      const value = error as { code?: number; stdout?: string; stderr?: string };
      const output = `${value.stdout ?? ""}${value.stderr ?? ""}`;
      return {
        exitCode: typeof value.code === "number" ? value.code : 1,
        output: output.slice(-65_536),
        truncated: output.length > 65_536,
      };
    }
  }

  async startCommand(
    ref: VendorRef,
    options: { command: string; cwd?: string; env?: Record<string, string> },
  ): Promise<CommandHandle> {
    const sandbox = await this.requireSandbox(ref);
    const argv = assertCommandAllowed(sandbox.labels["forksafe.purpose"] as SandboxSpec["purpose"], options.command, options.cwd);
    const sessionId = `forksafe-${randomUUID()}`;
    const commandId = randomUUID();
    const logPath = `/tmp/${commandId}.log`;
    const exitPath = `/tmp/${commandId}.exit`;
    const commandLine = argv.map(shellQuote).join(" ");
    const cwd = options.cwd ? `cd ${shellQuote(options.cwd)} && ` : "";
    const env = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
    const script = `${cwd}${env ? `env ${env} ` : ""}${commandLine} > ${shellQuote(logPath)} 2>&1; echo $? > ${shellQuote(exitPath)}`;
    await this.runDocker(["exec", "-d", ref.id, "sh", "-c", script]);
    return { sessionId, commandId };
  }

  async pollCommand(
    ref: VendorRef,
    handle: CommandHandle,
    options: { maxBytes: number },
  ): Promise<PollCommandResult> {
    await this.requireSandbox(ref);
    const maxBytes = Math.min(Math.max(0, options.maxBytes), 65_536);
    const logPath = `/tmp/${handle.commandId}.log`;
    const exitPath = `/tmp/${handle.commandId}.exit`;
    let logs = "";
    let exitCode: number | undefined;
    try {
      logs = (await this.runDocker(["exec", ref.id, "cat", logPath])).stdout;
    } catch {}
    try {
      const parsed = Number((await this.runDocker(["exec", ref.id, "cat", exitPath])).stdout.trim());
      if (Number.isInteger(parsed)) exitCode = parsed;
    } catch {}
    const bytes = Buffer.from(logs);
    return {
      done: exitCode !== undefined,
      ...(exitCode === undefined ? {} : { exitCode }),
      logs: bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8"),
      truncated: bytes.length > maxBytes,
    };
  }

  async uploadFile(ref: VendorRef, remotePath: string, bytes: Uint8Array): Promise<void> {
    await this.requireSandbox(ref);
    const directory = await mkdtemp(join(tmpdir(), "forksafe-upload-"));
    const localPath = join(directory, "artifact");
    try {
      await writeFile(localPath, bytes, { mode: 0o600 });
      await this.runDocker(["cp", localPath, `${ref.id}:${remotePath}`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async downloadFile(ref: VendorRef, remotePath: string): Promise<Uint8Array> {
    await this.requireSandbox(ref);
    const directory = await mkdtemp(join(tmpdir(), "forksafe-download-"));
    const localPath = join(directory, "artifact");
    try {
      await this.runDocker(["cp", `${ref.id}:${remotePath}`, localPath]);
      return new Uint8Array(await readFile(localPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async requireSandbox(ref: VendorRef): Promise<SandboxHandle> {
    const sandbox = await this.get(ref);
    if (!sandbox) throw new Error("sandbox_not_found");
    if (sandbox.labels["forksafe.project"] !== "forksafe") throw new Error("sandbox_not_owned");
    return sandbox;
  }

  private assertRef(ref: VendorRef): void {
    if (ref.provider !== "local") throw new Error("sandbox_provider_mismatch");
  }

  private async runDocker(args: string[]): Promise<ExecResult> {
    try {
      return await this.execFile("docker", args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    } catch {
      throw new Error("docker_command_failed");
    }
  }
}

export type { ExecFile };
