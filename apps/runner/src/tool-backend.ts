import { createHmac, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  Finding,
  type EvidenceKind,
  type FindingKind,
} from "@forksafe/contracts";
import type { ForkSafeToolBackend, ToolCallContext } from "@forksafe/agents";
import { assertFence } from "./fencing.js";
import { FencedError } from "./job-source.js";
import type { Lease } from "./protocol.js";

type BackendInput = Parameters<ForkSafeToolBackend["run_experiment"]>[0];

export class HttpToolBackend implements ForkSafeToolBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly lease: Lease,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    private readonly credentialId?: string,
  ) {}

  inspect_failure(input: Parameters<ForkSafeToolBackend["inspect_failure"]>[0], ctx: ToolCallContext) { return this.post("inspect_failure", input, ctx); }
  read_source(input: Parameters<ForkSafeToolBackend["read_source"]>[0], ctx: ToolCallContext) { return this.post("read_source", input, ctx); }
  apply_patch(input: Parameters<ForkSafeToolBackend["apply_patch"]>[0], ctx: ToolCallContext) { return this.post("apply_patch", input, ctx); }
  fork_candidate(input: Parameters<ForkSafeToolBackend["fork_candidate"]>[0], ctx: ToolCallContext) { return this.post("fork_candidate", input, ctx); }
  request_subtask(input: Parameters<ForkSafeToolBackend["request_subtask"]>[0], ctx: ToolCallContext) { return this.post("request_subtask", input, ctx); }
  run_experiment(input: BackendInput, ctx: ToolCallContext) { return this.post("run_experiment", input, ctx); }
  propose_controller_revision(input: Parameters<ForkSafeToolBackend["propose_controller_revision"]>[0], ctx: ToolCallContext) { return this.post("propose_controller_revision", input, ctx); }
  submit_candidate(input: Parameters<ForkSafeToolBackend["submit_candidate"]>[0], ctx: ToolCallContext) { return this.post("submit_candidate", input, ctx); }
  read_findings(input: Parameters<ForkSafeToolBackend["read_findings"]>[0], ctx: ToolCallContext) { return this.post("read_findings", input, ctx); }
  write_finding(input: Parameters<ForkSafeToolBackend["write_finding"]>[0], ctx: ToolCallContext) { return this.post("write_finding", input, ctx); }
  request_evidence(input: Parameters<ForkSafeToolBackend["request_evidence"]>[0], ctx: ToolCallContext) { return this.post("request_evidence", input, ctx); }

  private async post(name: string, input: unknown, ctx: ToolCallContext): Promise<unknown> {
    assertFence(this.lease, this.clock());
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("ForkSafe tool input must be an object");
    const callId = ctx.callId ?? randomUUID();
    const rawBody = JSON.stringify({ ...ctx, callId, ...(input as Record<string, unknown>) });
    const timestamp = String(this.clock());
    const signature = createHmac("sha256", this.secret).update(`${timestamp}.${rawBody}`).digest("hex");
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/runner/tools/${name}`, {
          method: "POST",
          headers: {
            "content-type": "application/json", "x-forksafe-signature": signature, "x-forksafe-timestamp": timestamp,
            ...(this.credentialId ? { "x-forksafe-runner": this.credentialId } : {}),
          },
          body: rawBody,
        });
      } catch (error) {
        if (attempt < 2) continue;
        throw error;
      }
      const text = await response.text();
      if (response.ok) return JSON.parse(text) as unknown;
      if (response.status >= 500 && attempt < 2) continue;
      let detail = "";
      try { detail = String((JSON.parse(text) as { error?: string }).error ?? ""); } catch { detail = ""; }
      if (response.status === 409 && detail === "stale_epoch") throw new FencedError();
      throw new Error(`Runner tool ${name} failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
    }
    throw new Error(`Runner tool ${name} exhausted retries`);
  }

  async completeSubtask(ctx: ToolCallContext, result: unknown): Promise<void> {
    await this.post("request_subtask", { subtaskResult: result }, ctx);
  }
}

export class LocalToolBackend implements ForkSafeToolBackend {
  constructor(private readonly dir: string, private readonly clock: () => number = Date.now) {}

  async inspect_failure() { return { mode: "local", status: "blocked", reason: "control_plane_required" }; }
  async read_source() { return { mode: "local", status: "blocked", reason: "control_plane_required" }; }
  async apply_patch() { return { mode: "local", status: "blocked", reason: "control_plane_required" }; }
  async fork_candidate() { return { mode: "local", status: "blocked", reason: "control_plane_required" }; }
  async request_subtask() { return { mode: "local", status: "blocked", reason: "runner_orchestration_required" }; }
  async run_experiment(_input: BackendInput) {
    return { status: "blocked", reason: "no execution adapter configured (RUNNER_CONTROL_URL unset)" };
  }

  async propose_controller_revision() {
    return { status: "blocked", reason: "no_control_plane", detail: "revisions require the Convex control plane" };
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
