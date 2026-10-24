import { createHmac } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Attempt,
  ExecutionGrant,
  Job,
  type Heartbeat,
} from "@forksafe/contracts";
import { z } from "zod";
import {
  ClaimRequest,
  ClaimResponse,
  CompletionRequest,
  CompletionResponse,
  HeartbeatResponse,
  type Lease,
} from "./protocol.js";
import { LEASE_TTL_MS } from "./heartbeat.js";

export interface JobSource {
  claim(request: z.infer<typeof ClaimRequest>): Promise<Lease | null>;
  heartbeat(heartbeat: Heartbeat): Promise<z.infer<typeof HeartbeatResponse>>;
  complete(completion: z.infer<typeof CompletionRequest>): Promise<z.infer<typeof CompletionResponse>>;
}

export class HttpJobSource implements JobSource {
  constructor(private readonly baseUrl: string, private readonly secret: string, private readonly fetcher: typeof fetch = fetch) {}

  claim(request: z.infer<typeof ClaimRequest>): Promise<Lease | null> {
    return this.post("claim", request, ClaimResponse).then((response) => response.lease);
  }

  heartbeat(heartbeat: Heartbeat): Promise<z.infer<typeof HeartbeatResponse>> {
    return this.post("heartbeat", heartbeat, HeartbeatResponse);
  }

  complete(completion: z.infer<typeof CompletionRequest>): Promise<z.infer<typeof CompletionResponse>> {
    return this.post("complete", completion, CompletionResponse);
  }

  private async post<S extends z.ZodTypeAny>(endpoint: string, body: unknown, schema: S): Promise<z.output<S>> {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", this.secret).update(rawBody).digest("hex");
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/runner/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forksafe-signature": signature,
        "x-forksafe-timestamp": timestamp,
      },
      body: rawBody,
    });
    if (!response.ok) throw new Error(`Runner ${endpoint} failed: HTTP ${response.status}`);
    return schema.parse(await response.json());
  }
}

type FileAttempt = { attempt: z.infer<typeof Attempt>; grant: z.infer<typeof ExecutionGrant> };
const State = z.object({
  attempts: z.record(z.array(z.object({ attempt: Attempt, grant: ExecutionGrant }))).default({}),
  active: z.record(z.string()).default({}),
  completions: z.record(z.object({ operationId: z.string(), response: CompletionResponse })).default({}),
});
type FileState = z.infer<typeof State>;

export class FileJobSource implements JobSource {
  private state: FileState = { attempts: {}, active: {}, completions: {} };
  private loaded = false;
  constructor(private readonly dir: string, private readonly clock: () => number = Date.now) {}

  async claim(input: z.infer<typeof ClaimRequest>): Promise<Lease | null> {
    const request = ClaimRequest.parse(input);
    if (request.capacity <= 0) return null;
    await this.load();
    const jobsDir = join(this.dir, "jobs");
    await mkdir(jobsDir, { recursive: true });
    const files = (await readdir(jobsDir)).filter((file) => file.endsWith(".json")).sort();
    for (const file of files) {
      const path = join(jobsDir, file);
      const job = Job.parse(JSON.parse(await readFile(path, "utf8")));
      if (!request.kinds.includes(job.kind) || ["succeeded", "failed", "cancelled"].includes(job.state)) continue;
      const previousAttemptId = this.state.active[job.id];
      const previous = previousAttemptId ? this.findAttempt(job.id, previousAttemptId) : undefined;
      if (previous && previous.attempt.leasedUntilMs > this.clock()) continue;
      if (previous) {
        job.epoch = Math.max(job.epoch, previous.attempt.epoch) + 1;
        previous.attempt.state = "fenced";
        previous.attempt.endedAtMs = this.clock();
      }
      const now = this.clock();
      const leasedUntilMs = now + LEASE_TTL_MS;
      const epoch = job.epoch;
      const attempt = Attempt.parse({
        id: crypto.randomUUID(), jobId: job.id, epoch, state: "leased",
        workerId: request.workerId, leasedUntilMs, lastHeartbeatMs: now, startedAtMs: now,
      });
      const grant = ExecutionGrant.parse({
        id: crypto.randomUUID(), jobId: job.id, attemptId: attempt.id, epoch,
        investigationId: job.investigationId, environmentId: job.environmentId,
        scope: { operations: ["run_experiment", "submit_candidate", "read_findings", "write_finding", "request_evidence"], artifactPrefixes: [], maxBytes: 0 },
        expiresAtMs: leasedUntilMs,
      });
      job.activeAttemptId = attempt.id;
      job.state = "running";
      job.attemptsUsed += 1;
      job.updatedAtMs = now;
      await writeFile(path, `${JSON.stringify(Job.parse(job), null, 2)}\n`, "utf8");
      this.state.attempts[job.id] ??= [];
      this.state.attempts[job.id]!.push({ attempt, grant });
      this.state.active[job.id] = attempt.id;
      await this.save();
      return { job, attempt, grant };
    }
    return null;
  }

  async heartbeat(input: Heartbeat): Promise<z.infer<typeof HeartbeatResponse>> {
    await this.load();
    const found = await this.findByAttempt(input.attemptId);
    if (!found) return { ok: false, reason: "unknown_attempt" };
    const { job, record } = found;
    if (this.state.active[job.id] !== input.attemptId || record.attempt.epoch !== input.epoch || record.grant.id !== input.grantId) {
      return { ok: false, reason: "fenced" };
    }
    if (record.grant.revokedAtMs !== undefined) return { ok: false, reason: "revoked" };
    if (record.attempt.leasedUntilMs <= this.clock() || record.grant.expiresAtMs <= this.clock()) return { ok: false, reason: "expired" };
    const leasedUntilMs = this.clock() + LEASE_TTL_MS;
    record.attempt.lastHeartbeatMs = this.clock();
    record.attempt.leasedUntilMs = leasedUntilMs;
    record.attempt.state = "heartbeating";
    record.grant.expiresAtMs = leasedUntilMs;
    await this.save();
    return { ok: true, leasedUntilMs, epoch: record.attempt.epoch };
  }

  async complete(input: z.infer<typeof CompletionRequest>): Promise<z.infer<typeof CompletionResponse>> {
    const completion = CompletionRequest.parse(input);
    await this.load();
    const prior = this.state.completions[completion.operationId];
    if (prior) return prior.response;
    const found = await this.findByAttempt(completion.attemptId);
    if (!found) return { accepted: false, reason: "unknown_attempt" };
    const { job, record } = found;
    if (
      this.state.active[job.id] !== completion.attemptId
      || completion.jobId !== job.id
      || completion.grantId !== record.grant.id
      || completion.epoch !== job.epoch
      || completion.epoch !== record.attempt.epoch
    ) return { accepted: false, reason: "fenced" };
    if (record.grant.revokedAtMs !== undefined) return { accepted: false, reason: "revoked" };
    if (record.attempt.leasedUntilMs <= this.clock() || record.grant.expiresAtMs <= this.clock()) return { accepted: false, reason: "expired" };
    const response = { accepted: true };
    record.attempt.state = completion.outcome === "succeeded" ? "succeeded" : "failed";
    record.attempt.endedAtMs = completion.finishedAtMs;
    job.state = completion.outcome;
    job.activeAttemptId = undefined;
    job.updatedAtMs = completion.finishedAtMs;
    await this.writeJob(job);
    delete this.state.active[job.id];
    this.state.completions[completion.operationId] = { operationId: completion.operationId, response };
    await this.save();
    return response;
  }

  private async writeJob(job: z.infer<typeof Job>): Promise<void> {
    await writeFile(join(this.dir, "jobs", `${job.id}.json`), `${JSON.stringify(Job.parse(job), null, 2)}\n`, "utf8");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(this.dir, { recursive: true });
    try {
      this.state = State.parse(JSON.parse(await readFile(join(this.dir, "state.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { attempts: {}, active: {}, completions: {} };
    }
  }

  private async save(): Promise<void> {
    await writeFile(join(this.dir, "state.json"), `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  private findAttempt(jobId: string, attemptId: string): FileAttempt | undefined {
    return this.state.attempts[jobId]?.find((item) => item.attempt.id === attemptId);
  }

  private async findByAttempt(attemptId: string): Promise<{ job: z.infer<typeof Job>; record: FileAttempt } | undefined> {
    for (const [jobId, records] of Object.entries(this.state.attempts)) {
      const record = records.find((item) => item.attempt.id === attemptId);
      if (!record) continue;
      const job = Job.parse(JSON.parse(await readFile(join(this.dir, "jobs", `${jobId}.json`), "utf8")));
      return { job, record };
    }
    return undefined;
  }
}
