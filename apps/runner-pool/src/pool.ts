import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export type RunnerClaim = {
  credentialId: string;
  secret: string;
  environmentId: string;
  investigationId: string;
  jobSourceUrl: string;
  controlUrl: string;
  expiresAtMs: number;
};

type ChildSlot = {
  child: ChildProcess;
  claim: RunnerClaim;
  poolWorkerId: string;
  exited: boolean;
  done: Promise<void>;
  finish: () => void;
};

export type RunnerPoolOptions = {
  convexSiteUrl: string;
  token: string;
  maxRunners?: number;
  pollIntervalMs?: number;
  runnerEntryPoint?: string;
  workRoot?: string;
  fetcher?: typeof fetch;
  spawnRunner?: (entryPoint: string, options: SpawnOptions) => ChildProcess;
  logger?: (message: string) => void;
  random?: () => number;
};

const defaultRunnerEntryPoint = resolve(dirname(fileURLToPath(import.meta.url)), "../../runner/dist/runner.mjs");

export class RunnerPool {
  private readonly siteUrl: string;
  private readonly token: string;
  private readonly maxRunners: number;
  private readonly pollIntervalMs: number;
  private readonly runnerEntryPoint: string;
  private readonly workRoot: string;
  private readonly fetcher: typeof fetch;
  private readonly spawnRunner: NonNullable<RunnerPoolOptions["spawnRunner"]>;
  private readonly logger: (message: string) => void;
  private readonly random: () => number;
  private readonly children = new Map<string, ChildSlot>();
  private readonly abortController = new AbortController();
  private server?: Server;
  private loop?: Promise<void>;
  private stopping = false;

  constructor(options: RunnerPoolOptions) {
    this.siteUrl = new URL(options.convexSiteUrl).origin;
    this.token = options.token;
    this.maxRunners = options.maxRunners ?? 4;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.runnerEntryPoint = options.runnerEntryPoint ?? defaultRunnerEntryPoint;
    this.workRoot = options.workRoot ?? resolve("./var/runner-pool");
    this.fetcher = options.fetcher ?? fetch;
    this.spawnRunner = options.spawnRunner ?? ((entryPoint, spawnOptions) =>
      spawn(process.execPath, [entryPoint], spawnOptions));
    this.logger = options.logger ?? console.info;
    this.random = options.random ?? Math.random;
    if (!Number.isInteger(this.maxRunners) || this.maxRunners < 1) throw new Error("POOL_MAX_RUNNERS must be a positive integer");
  }

  get activeRunners(): number {
    return this.children.size;
  }

  async start(port: number): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/healthz") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", activeRunners: this.activeRunners, maxRunners: this.maxRunners }));
    });
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "0.0.0.0", resolveListen);
    });
    this.loop = this.pollLoop();
  }

  async tick(): Promise<boolean> {
    if (this.stopping || this.children.size >= this.maxRunners) return false;
    const poolWorkerId = `${hostname()}-${randomUUID()}`;
    let response: Response;
    try {
      response = await this.fetcher(`${this.siteUrl}/runner/pool/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ poolWorkerId }),
        signal: this.abortController.signal,
      });
    } catch (error) {
      if (!this.stopping) throw error;
      return false;
    }
    if (response.status === 204) return false;
    if (!response.ok) throw new Error(`pool claim failed with HTTP ${response.status}`);
    const claim = await response.json() as RunnerClaim;
    if (!this.isClaim(claim)) throw new Error("pool claim response was invalid");
    if (this.stopping) {
      await this.release(claim, poolWorkerId);
      return false;
    }
    await this.spawnClaim(claim, poolWorkerId);
    return true;
  }

  async stop(gracePeriodMs = 25_000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.abortController.abort();
    await new Promise<void>((resolveClose) => {
      if (!this.server) return resolveClose();
      this.server.close(() => resolveClose());
    });
    const slots = [...this.children.values()];
    for (const slot of slots) slot.child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(slots.map((slot) => slot.done)),
      new Promise<void>((resolveTimeout) => { timer = setTimeout(resolveTimeout, gracePeriodMs); }),
    ]);
    if (timer) clearTimeout(timer);
    for (const slot of slots) {
      if (!slot.exited) slot.child.kill("SIGKILL");
    }
    await Promise.all(slots.map((slot) => slot.done));
    await this.loop;
  }

  private async pollLoop(): Promise<void> {
    let backoffMs = 1_000;
    while (!this.stopping) {
      if (this.children.size >= this.maxRunners) {
        await this.wait(this.jitter(this.pollIntervalMs));
        continue;
      }
      try {
        if (await this.tick()) {
          backoffMs = 1_000;
          continue;
        }
        await this.wait(this.jitter(this.pollIntervalMs));
      } catch {
        if (this.stopping) break;
        this.logger("runner pool claim failed; retrying");
        await this.wait(this.jitter(backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  private async spawnClaim(claim: RunnerClaim, poolWorkerId: string): Promise<void> {
    const runnerCwd = join(this.workRoot, claim.environmentId);
    let child: ChildProcess;
    try {
      await mkdir(runnerCwd, { recursive: true });
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        RUNNER_CALLBACK_SECRET: claim.secret,
        RUNNER_CREDENTIAL_ID: claim.credentialId,
        RUNNER_ENVIRONMENT_ID: claim.environmentId,
        RUNNER_INVESTIGATION_ID: claim.investigationId,
        RUNNER_WORKER_ID: poolWorkerId,
        RUNNER_JOB_SOURCE_URL: claim.jobSourceUrl,
        RUNNER_CONTROL_URL: claim.controlUrl,
        RUNNER_WORKSPACE_ROOT: join(runnerCwd, "workspaces"),
        RUNNER_JOBS_DIR: join(runnerCwd, "jobs"),
      };
      delete childEnv.RUNNER_POOL_TOKEN;
      child = this.spawnRunner(this.runnerEntryPoint, { cwd: runnerCwd, env: childEnv, stdio: "inherit" });
    } catch (error) {
      await this.release(claim, poolWorkerId);
      throw error;
    }
    let finish!: () => void;
    const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
    const slot: ChildSlot = { child, claim, poolWorkerId, exited: false, done, finish };
    this.children.set(claim.environmentId, slot);
    child.once("exit", (code) => {
      slot.exited = true;
      this.children.delete(claim.environmentId);
      const settled = code === 0 ? this.release(claim, poolWorkerId) : Promise.resolve();
      void settled.finally(finish);
    });
    child.once("error", () => {
      slot.exited = true;
      this.children.delete(claim.environmentId);
      void this.release(claim, poolWorkerId).finally(finish);
    });
  }

  private async release(claim: RunnerClaim, poolWorkerId: string): Promise<void> {
    try {
      const response = await this.fetcher(`${this.siteUrl}/runner/pool/release`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ credentialId: claim.credentialId, poolWorkerId }),
        signal: this.stopping ? undefined : this.abortController.signal,
      });
      if (!response.ok) this.logger("runner pool release failed; lease will expire");
    } catch {
      this.logger("runner pool release failed; lease will expire");
    }
  }

  private isClaim(value: RunnerClaim): boolean {
    return !!value && typeof value.credentialId === "string" && typeof value.secret === "string"
      && typeof value.environmentId === "string" && typeof value.investigationId === "string"
      && typeof value.jobSourceUrl === "string" && typeof value.controlUrl === "string"
      && typeof value.expiresAtMs === "number";
  }

  private jitter(baseMs: number): number {
    return Math.max(1, Math.round(baseMs * (0.8 + this.random() * 0.4)));
  }

  private async wait(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolveWait) => {
      const finish = () => {
        clearTimeout(timer);
        this.abortController.signal.removeEventListener("abort", finish);
        resolveWait();
      };
      const timer = setTimeout(finish, ms);
      this.abortController.signal.addEventListener("abort", finish, { once: true });
    });
  }
}
