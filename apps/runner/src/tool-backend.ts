import { createHmac } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  Finding,
  type EvidenceKind,
  type FindingKind,
} from "@forksafe/contracts";
import type { ForkSafeToolBackend, ToolCallContext } from "@forksafe/agents";
import { assertFence } from "./fencing.js";
import type { Lease } from "./protocol.js";

type BackendInput = Parameters<ForkSafeToolBackend["run_experiment"]>[0];

export class HttpToolBackend implements ForkSafeToolBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly lease: Lease,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  run_experiment(input: BackendInput, ctx: ToolCallContext) { return this.post("run_experiment", input, ctx); }
  submit_candidate(input: Parameters<ForkSafeToolBackend["submit_candidate"]>[0], ctx: ToolCallContext) { return this.post("submit_candidate", input, ctx); }
  read_findings(input: Parameters<ForkSafeToolBackend["read_findings"]>[0], ctx: ToolCallContext) { return this.post("read_findings", input, ctx); }
  write_finding(input: Parameters<ForkSafeToolBackend["write_finding"]>[0], ctx: ToolCallContext) { return this.post("write_finding", input, ctx); }
  request_evidence(input: Parameters<ForkSafeToolBackend["request_evidence"]>[0], ctx: ToolCallContext) { return this.post("request_evidence", input, ctx); }

  private async post(name: string, input: unknown, ctx: ToolCallContext): Promise<unknown> {
    assertFence(this.lease, this.clock());
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("ForkSafe tool input must be an object");
    const rawBody = JSON.stringify({ ...ctx, ...(input as Record<string, unknown>) });
    const timestamp = String(this.clock());
    const signature = createHmac("sha256", this.secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/runner/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forksafe-signature": signature, "x-forksafe-timestamp": timestamp },
      body: rawBody,
    });
    if (!response.ok) throw new Error(`Runner tool ${name} failed: HTTP ${response.status}`);
    return response.json();
  }
}

export class LocalToolBackend implements ForkSafeToolBackend {
  constructor(private readonly dir: string, private readonly clock: () => number = Date.now) {}

  async run_experiment(_input: BackendInput) {
    return { status: "blocked", reason: "no execution adapter configured (RUNNER_CONTROL_URL unset)" };
  }

  async submit_candidate() {
    return { status: "blocked", reason: "no execution adapter configured (RUNNER_CONTROL_URL unset)" };
  }

  async read_findings(input: { scope: "environment" | "investigation"; limit: number }) {
    let lines: string[];
    try {
      lines = (await readFile(join(this.dir, "findings.jsonl"), "utf8")).split("\n").filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "local", findings: [] };
      throw error;
    }
    const findings = lines.map((line) => JSON.parse(line)).slice(-input.limit);
    return { mode: "local", findings };
  }

  async write_finding(input: {
    kind: FindingKind;
    summary: string;
    evidence: { kind: EvidenceKind; experimentId?: string; artifactId?: string; locator: Record<string, unknown>; excerpt?: string }[];
  }, ctx: ToolCallContext) {
    const finding = Finding.parse({
      id: crypto.randomUUID(),
      investigationId: ctx.investigationId,
      environmentId: ctx.environmentId,
      sessionId: ctx.sessionId,
      kind: input.kind,
      summary: input.summary,
      evidence: input.evidence,
      createdAtMs: this.clock(),
    });
    const file = join(this.dir, "findings.jsonl");
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(finding)}\n`, "utf8");
    return { mode: "local", finding };
  }

  async request_evidence(input: { query: string; experimentId?: string }) {
    return { mode: "local", status: "blocked", reason: "no evidence adapter configured", query: input.query };
  }
}
