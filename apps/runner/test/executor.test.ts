import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { ActivityLog, FixtureFactoryAdapter, SessionManager, SessionMissingError, UsageLedger, type AdapterSession, type AdapterSessionOptions, type FactoryAdapter } from "@forksafe/agents";
import { Job } from "@forksafe/contracts";
import { initTelemetry } from "@forksafe/telemetry";
import { RunnerTelemetry } from "../src/telemetry.js";
import { ActiveToolBackend } from "../src/main.js";
import { FileJobSource } from "../src/job-source.js";
import { LocalToolBackend } from "../src/tool-backend.js";
import { RunnerExecutor } from "../src/executor.js";
import { sampleLease } from "./helpers.js";

class PreservingSpanExporter extends InMemorySpanExporter {
  override async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

const dirs: string[] = [];

class PromptCapturingAdapter extends FixtureFactoryAdapter {
  readonly prompts: string[] = [];

  override async createSession(options: AdapterSessionOptions): Promise<AdapterSession> {
    const session = await super.createSession(options);
    const prompts = this.prompts;
    return {
      ...session,
      async *stream(prompt, streamOptions) {
        prompts.push(prompt);
        yield* session.stream(prompt, streamOptions);
      },
    };
  }
}

async function setup(
  adapter = new FixtureFactoryAdapter(),
  onTurnComplete?: ConstructorParameters<typeof SessionManager>[0]["onTurnComplete"],
  onSessionReady?: ConstructorParameters<typeof SessionManager>[0]["onSessionReady"],
  toolBackendFactory?: (dir: string) => ConstructorParameters<typeof SessionManager>[0]["toolBackend"],
) {
  const dir = await mkdtemp(join(tmpdir(), "forksafe-executor-"));
  dirs.push(dir);
  const manager = new SessionManager({
    adapter, ledger: new UsageLedger(), workspaceRoot: join(dir, "workspaces"),
    toolBackend: toolBackendFactory?.(dir) ?? new LocalToolBackend(join(dir, "local")),
    log: new ActivityLog(), onTurnComplete, onSessionReady,
  });
  return { dir, manager };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("RunnerExecutor", () => {
  it("includes prior hints in the first repair turn", async () => {
    const adapter = new PromptCapturingAdapter();
    const { manager } = await setup(adapter as unknown as FixtureFactoryAdapter);
    const lease = sampleLease();
    lease.job.payload = {
      repair: {
        investigationTitle: "Panda clips divider",
        environmentIndex: 0,
        baselineCase: { caseId: "case", suite: "original", seed: 1, sceneOverrides: {} },
        failureSummary: "Collision",
        findingsDigest: "No current findings.",
        budgets: {},
        priorHints: [
          { findingId: "finding-one", sourceInvestigationId: "investigation-one", summary: "First prior hint." },
          { findingId: "finding-two", sourceInvestigationId: "investigation-two", summary: "Second prior hint." },
        ],
      },
    };
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async () => ({ accepted: true })),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog(), maxTurns: 1 });

    await executor.execute(lease);

    expect(adapter.prompts[0]).toContain("Prior hints from earlier investigations");
    expect(adapter.prompts[0]).toContain("finding-one");
    expect(adapter.prompts[0]).toContain("finding-two");
  });

  it("keeps runner telemetry disabled when no endpoint is configured", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry({
      serviceName: "forksafe-runner-test",
      env: {},
      spanExporter: exporter,
    });
    const runnerTelemetry = new RunnerTelemetry(telemetry);
    runnerTelemetry.beginAttempt("attempt");
    await runnerTelemetry.withToolSpan("read_findings", "attempt", async () => ({ status: "ok" }));
    await telemetry.shutdown();

    expect(telemetry.enabled).toBe(false);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it("exports a privacy-filtered job trace with child tool spans and unknown usage", async () => {
    const exporter = new PreservingSpanExporter();
    const telemetry = initTelemetry({
      serviceName: "forksafe-runner-test",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
      spanExporter: exporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
        exportIntervalMillis: 60_000,
      }),
    });
    const runnerTelemetry = new RunnerTelemetry(telemetry);
    const lease = sampleLease();
    const privatePrompt = ["private", "prompt"].join("-");
    lease.job.payload.prompt = privatePrompt;
    let activeBackend: ActiveToolBackend | undefined;
    const adapter = new FixtureFactoryAdapter({
      usage: "unknown",
      gate: async () => {
        const toolContext = {
          investigationId: lease.job.investigationId,
          environmentId: lease.job.environmentId!,
          sessionId: "fixture-session",
          attemptId: lease.attempt.id,
          grantId: lease.grant.id,
          epoch: lease.attempt.epoch,
        };
        await activeBackend!.read_findings({ scope: "environment", limit: 1 }, toolContext);
        await activeBackend!.run_experiment({
          caseId: crypto.randomUUID(),
          seed: 1,
          hypothesis: "only used to exercise the tool wrapper",
        }, toolContext);
      },
    });
    const { manager } = await setup(adapter, undefined, undefined, (dir) => {
      const local = new LocalToolBackend(join(dir, "local"));
      local.run_experiment = async () => ({ status: "ok", reason: "ok" });
      activeBackend = new ActiveToolBackend(local, runnerTelemetry);
      return activeBackend;
    });
    const source = {
      session: vi.fn(async () => ({ ok: true })),
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async () => ({ accepted: true })),
    };
    const job = telemetry.startSpan("runner.job", { "forksafe.job_id": lease.job.id });
    await telemetry.withSpan("runner.claim", {}, async () => undefined, { parent: job.context });
    const executor = new RunnerExecutor({
      sessions: manager,
      source: source as never,
      log: new ActivityLog(),
      maxTurns: 1,
      telemetry: runnerTelemetry,
    });

    await expect(executor.execute(lease, job.context)).resolves.toMatchObject({ accepted: true });
    await telemetry.shutdown();

    const spans = exporter.getFinishedSpans();
    const byName = (name: string) => spans.find((span) => span.name === name);
    const root = byName("runner.job");
    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining([
      "runner.job", "runner.claim", "runner.grant", "runner.turn", "runner.tool",
      "runner.artifacts", "runner.complete",
    ]));
    expect(root?.attributes["forksafe.outcome"]).toBe("succeeded");
    expect(byName("runner.turn")?.attributes["forksafe.tokens.known"]).toBe(false);
    expect(byName("runner.turn")?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    const tool = spans.find((span) => span.name === "runner.tool" && span.attributes["forksafe.tool.name"] === "run_experiment");
    expect(tool?.attributes["forksafe.tool.status"]).toBe("ok");
    expect(byName("runner.artifacts")?.attributes["forksafe.artifacts.count"]).toBe(1);
    for (const span of spans) {
      expect(span.attributes).not.toHaveProperty("prompt");
      expect(Object.keys(span.attributes).every((key) => [
        "forksafe.investigation_id", "forksafe.environment_id", "forksafe.job_id",
        "forksafe.attempt_id", "forksafe.grant_id", "forksafe.epoch", "forksafe.session_id",
        "forksafe.vendor_session_id", "forksafe.turn.index", "forksafe.turn.mode",
        "forksafe.turn.success", "forksafe.turn.tool_calls", "forksafe.tokens.known",
        "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "forksafe.tokens.cache_read",
        "forksafe.tokens.cache_creation", "forksafe.tokens.thinking", "forksafe.factory_credits",
        "forksafe.tool.name", "forksafe.tool.status", "forksafe.tool.is_error", "forksafe.outcome",
        "forksafe.completion.accepted", "forksafe.completion.attempts", "forksafe.candidate_submitted",
        "forksafe.artifacts.count", "forksafe.lease.abort_reason", "forksafe.eval.suite",
        "forksafe.eval.candidate_id", "forksafe.eval.case_id", "forksafe.eval.case_index",
        "forksafe.eval.case_status", "forksafe.eval.status", "forksafe.eval.cases",
        "http.request.method", "http.response.status_code", "url.path", "error.type",
      ].includes(key))).toBe(true);
    }
    expect(JSON.stringify(spans)).not.toContain(privatePrompt);
    for (const name of ["runner.claim", "runner.grant", "runner.turn", "runner.artifacts", "runner.complete"]) {
      expect(byName(name)?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    }
    expect(tool?.parentSpanContext?.spanId).toBe(byName("runner.turn")?.spanContext().spanId);
    await manager.closeAll();
  });

  it("registers the session with the job source before the first turn", async () => {
    const order: string[] = [];
    const adapter = new FixtureFactoryAdapter({ gate: async () => { order.push("runTurn"); } });
    Object.defineProperty(adapter, "mode", { value: "live" });
    const source = {
      session: vi.fn(async ({ session }: {
        attemptId: string; epoch: number; session: { state: string };
      }) => {
        if (session.state === "created") order.push("session");
        return { ok: true };
      }),
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async () => ({ accepted: true })),
    };
    const { manager } = await setup(adapter, undefined, async ({ attemptId, epoch, session }) => {
      expect(session.state).toBe("created");
      expect(session.mode).toBe("live");
      expect(session.factorySession).toMatchObject({ provider: "factory", id: "fixture-session-0001" });
      return source.session({ attemptId, epoch, session });
    });
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog(), maxTurns: 1 });
    await executor.execute(sampleLease());
    expect(order).toEqual(["session", "runTurn"]);
  });

  it("fails the lease as infrastructure failure when session registration is rejected", async () => {
    const { manager } = await setup(new FixtureFactoryAdapter(), undefined, async () => { throw new Error("HTTP 409"); });
    const completions: { outcome: string; result: Record<string, unknown> }[] = [];
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: { outcome: string; result: Record<string, unknown> }) => {
        completions.push(completion);
        return { accepted: true };
      }),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog() });
    await executor.execute(sampleLease());
    expect(completions[0]).toMatchObject({ outcome: "infra_failed" });
    expect(completions[0]?.result.error).toContain("session registration failed");
  });
  it("completes fixture work with usage and local vendor reference", async () => {
    const { dir, manager } = await setup();
    const jobsDir = join(dir, "jobs", "jobs");
    await mkdir(jobsDir, { recursive: true });
    const job = Job.parse({
      id: crypto.randomUUID(), kind: "factory_session", state: "granted",
      investigationId: crypto.randomUUID(), environmentId: crypto.randomUUID(),
      epoch: 0, idempotencyKey: "executor-test-idempotency",
      payload: { prompt: "test" }, attemptsUsed: 0, maxAttempts: 2,
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    await writeFile(join(jobsDir, `${job.id}.json`), JSON.stringify(job));
    const jobSource = new FileJobSource(join(dir, "jobs"));
    const lease = (await jobSource.claim({ workerId: "test", kinds: ["factory_session"], capacity: 1 }))!;
    const executor = new RunnerExecutor({ sessions: manager, source: jobSource, log: new ActivityLog() });
    const result = await executor.execute(lease);
    expect(result).toMatchObject({ accepted: true });
    const state = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "jobs", "state.json"), "utf8"));
    const completion = Object.values(state.completions)[0] as { response: unknown };
    expect(completion.response).toEqual({ accepted: true });
    const session = [...(manager as unknown as { sessions: Map<string, never> }).sessions.values()][0] as unknown as {
      adapterSession: { vendorId: string };
    };
    expect(session.adapterSession.vendorId).toBe("fixture-session-0001");
  });

  it("does not post a result after the lease is fenced mid-turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const { manager } = await setup(new FixtureFactoryAdapter({
      gate: () => { markEntered(); return gate; },
    }));
    const lease = sampleLease(20_000);
    const source = {
      // First beat (before session open) must succeed so the turn can start; later beats fence.
      heartbeat: vi.fn(async () => {
        if (source.heartbeat.mock.calls.length <= 1) {
          return { ok: true as const, leasedUntilMs: 50_000, epoch: 0 };
        }
        return { ok: false as const, reason: "fenced" as const };
      }),
      complete: vi.fn(async () => ({ accepted: true })),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog() });
    const task = executor.execute(lease);
    await entered;
    await vi.advanceTimersByTimeAsync(5_000);
    release();
    await expect(task).resolves.toBeNull();
    expect(source.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(source.complete).not.toHaveBeenCalled();
  });

  it("uses two sessions for concurrent jobs and fails a third at the environment cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let enteredCount = 0;
    let markBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => { markBothEntered = resolve; });
    const adapter = new FixtureFactoryAdapter({
      gate: () => {
        enteredCount += 1;
        if (enteredCount === 2) markBothEntered();
        return gate;
      },
    });
    const { manager } = await setup(adapter as unknown as FixtureFactoryAdapter);
    const baseLease = sampleLease();
    const siblingLease = (): typeof baseLease => {
      const lease = structuredClone(baseLease);
      lease.job.id = crypto.randomUUID();
      lease.job.idempotencyKey = crypto.randomUUID();
      lease.attempt.id = crypto.randomUUID();
      lease.attempt.jobId = lease.job.id;
      lease.grant.id = crypto.randomUUID();
      lease.grant.jobId = lease.job.id;
      lease.grant.attemptId = lease.attempt.id;
      return lease;
    };
    const secondLease = siblingLease();
    const thirdLease = siblingLease();
    const completions: {
      jobId: string;
      outcome: string;
      result: Record<string, unknown>;
      sessions: { provider: string; id: string }[];
    }[] = [];
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: {
        jobId: string;
        outcome: string;
        result: Record<string, unknown>;
        sessions: { provider: string; id: string }[];
      }) => {
        completions.push(completion);
        return { accepted: true };
      }),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog() });
    const firstTask = executor.execute(baseLease);
    const secondTask = executor.execute(secondLease);
    await bothEntered;

    expect(manager.idleSessionFor(baseLease.job.investigationId, baseLease.job.environmentId!)).toBeUndefined();
    await expect(executor.execute(thirdLease)).resolves.toMatchObject({ accepted: true });
    const capCompletion = completions.find((completion) => completion.jobId === thirdLease.job.id);
    expect(capCompletion).toMatchObject({
      outcome: "failed",
      result: { error: "environment_session_cap" },
      sessions: [],
    });

    release();
    await expect(Promise.all([firstTask, secondTask])).resolves.toEqual([
      { accepted: true },
      { accepted: true },
    ]);
    const usedSessions = completions
      .filter((completion) => completion.jobId !== thirdLease.job.id)
      .flatMap((completion) => completion.sessions.map((session) => session.id));
    expect(new Set(usedSessions).size).toBe(2);
    expect(enteredCount).toBe(2);
  });

  it("retries a thrown completion with the same operation ID", async () => {
    const { manager } = await setup();
    const lease = sampleLease();
    const operationIds: string[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: { operationId: string }) => {
        operationIds.push(completion.operationId);
        attempts += 1;
        if (attempts === 1) throw new Error("network unavailable");
        return { accepted: true };
      }),
    };
    const executor = new RunnerExecutor({
      sessions: manager,
      source: source as never,
      log: new ActivityLog(),
      sleep: async (ms) => { delays.push(ms); },
    });

    await expect(executor.execute(lease)).resolves.toEqual({ accepted: true });
    expect(source.complete).toHaveBeenCalledTimes(2);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[0]).toMatch(/^[\da-f-]{36}$/);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(delays).toEqual([250]);
  });

  it("resumes only from the primary checkpoint and continues the shared four-turn budget", async () => {
    const checkpoints: any[] = [];
    let turns = 0;
    const adapter = new FixtureFactoryAdapter({ gate: async () => {
      turns += 1;
      if (turns === 2) throw new Error("temporary infrastructure failure");
    } });
    Object.defineProperty(adapter, "mode", { value: "live" });
    const { manager } = await setup(adapter, async (checkpoint) => { checkpoints.push(checkpoint); });
    const createSpy = vi.spyOn(adapter, "createSession");
    const resumeSpy = vi.spyOn(adapter, "resumeSession");
    const lease = sampleLease();
    const completions: any[] = [];
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: any) => { completions.push(completion); return { accepted: true }; }),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog() });
    await expect(executor.execute(lease)).resolves.toMatchObject({ accepted: true });
    expect(completions[0]).toMatchObject({ outcome: "infra_failed" });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ role: "primary", turnIndex: 0 });

    const resumed = structuredClone(lease);
    resumed.attempt.id = crypto.randomUUID();
    resumed.attempt.jobId = resumed.job.id;
    resumed.grant.attemptId = resumed.attempt.id;
    resumed.job.payload.resume = checkpoints[0];
    const turnSpy = vi.spyOn(manager, "runTurn");
    await expect(executor.execute(resumed)).resolves.toMatchObject({ accepted: true });
    expect(resumeSpy).toHaveBeenCalledWith(checkpoints[0].vendorSessionId, expect.any(Object));
    expect(createSpy).toHaveBeenCalledOnce();
    expect(turnSpy.mock.calls[1]?.[1]).toContain("about two turns total");
    expect(turnSpy.mock.calls[1]?.[1]).toContain("submit_candidate");
    expect(checkpoints.map((checkpoint) => checkpoint.turnIndex)).toEqual([0, 1, 2, 3]);
  });

  it("does not end the session on a rejected submit_candidate", async () => {
    let streams = 0;
    const adapter: FactoryAdapter = {
      mode: "live",
      async createSession() {
        const vendorId = "live-reject-1";
        return {
          vendorId,
          async *stream() {
            streams += 1;
            yield { type: "assistant" as const, text: "submitting" };
            yield { type: "tool_call" as const, name: "submit_candidate", toolCallId: "c1" };
            yield { type: "tool_result" as const, isError: false, toolCallId: "c1", text: '{"status":"rejected","reason":"finding_missing"}' };
            yield {
              type: "result" as const, sessionId: vendorId, durationMs: 1, tokenUsage: null,
              text: "rejected", turnCount: 1, success: true, subtype: "success",
            };
          },
          async interrupt() {},
          async close() {},
        };
      },
      async resumeSession(vendorId: string) { throw new SessionMissingError(vendorId); },
    };
    const { manager } = await setup(adapter as unknown as FixtureFactoryAdapter);
    const lease = sampleLease();
    const completions: any[] = [];
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: any) => { completions.push(completion); return { accepted: true }; }),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog() });
    await expect(executor.execute(lease)).resolves.toMatchObject({ accepted: true });
    expect(streams).toBe(4);
    expect(completions[0].result.candidateSubmitted).toBe(false);
  });

  it("stops after an accepted submit_candidate", async () => {
    let streams = 0;
    const adapter: FactoryAdapter = {
      mode: "live",
      async createSession() {
        const vendorId = "live-accept-1";
        return {
          vendorId,
          async *stream() {
            streams += 1;
            yield { type: "tool_call" as const, name: "submit_candidate", toolCallId: "c1" };
            yield { type: "tool_result" as const, isError: false, toolCallId: "c1", text: '{"status":"submitted","candidateId":"abc"}' };
            yield {
              type: "result" as const, sessionId: vendorId, durationMs: 1, tokenUsage: null,
              text: "submitted", turnCount: 1, success: true, subtype: "success",
            };
          },
          async interrupt() {},
          async close() {},
        };
      },
      async resumeSession(vendorId: string) { throw new SessionMissingError(vendorId); },
    };
    const { manager } = await setup(adapter as unknown as FixtureFactoryAdapter);
    const lease = sampleLease();
    const completions: any[] = [];
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: any) => { completions.push(completion); return { accepted: true }; }),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog() });
    await expect(executor.execute(lease)).resolves.toMatchObject({ accepted: true });
    expect(streams).toBe(1);
    expect(completions[0].result.candidateSubmitted).toBe(true);
  });

  it("replaces a missing checkpoint vendor session while preserving lineage", async () => {
    const checkpoints: any[] = [];
    const adapter = new FixtureFactoryAdapter();
    const { manager } = await setup(adapter, async (checkpoint) => { checkpoints.push(checkpoint); });
    const lease = sampleLease();
    const completions: any[] = [];
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: any) => { completions.push(completion); return { accepted: true }; }),
    };
    const executor = new RunnerExecutor({ sessions: manager, source: source as never, log: new ActivityLog(), maxTurns: 1 });
    await executor.execute(lease);
    await manager.closeAll();
    (adapter as unknown as { sessions: Set<string> }).sessions.clear();
    const resumed = structuredClone(lease);
    resumed.attempt.id = crypto.randomUUID();
    resumed.grant.attemptId = resumed.attempt.id;
    resumed.job.payload.resume = checkpoints[0];
    await executor.execute(resumed);
    const replacementSessionId = completions[1]?.sessions[0]?.id;
    expect(manager.replacesSessionId(replacementSessionId)).toBe(checkpoints[0].sessionId);
  });
  it("reports a non-cap session-open failure as infra_failed instead of letting the lease expire", async () => {
    const lease = sampleLease();
    const completions: { outcome: string; result: Record<string, unknown> }[] = [];
    trace.disable();
    metrics.disable();
    const exporter = new PreservingSpanExporter();
    const telemetry = initTelemetry({
      serviceName: "forksafe-runner-test",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
      spanExporter: exporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
        exportIntervalMillis: 60_000,
      }),
    });
    const source = {
      heartbeat: vi.fn(async () => ({ ok: true as const, leasedUntilMs: Date.now() + 30_000, epoch: 0 })),
      complete: vi.fn(async (completion: { outcome: string; result: Record<string, unknown> }) => {
        completions.push(completion);
        return { accepted: true };
      }),
    };
    const sessions = {
      idleSessionFor: () => undefined,
      createSession: async () => {
        const error = new Error("Failed to start Droid: executable not found (droid)");
        error.name = "DroidExecutableMissingError";
        throw error;
      },
    };
    const executor = new RunnerExecutor({
      sessions: sessions as never,
      source: source as never,
      log: new ActivityLog(),
      telemetry: new RunnerTelemetry(telemetry),
    });
    try {
      await expect(executor.execute(lease)).resolves.toMatchObject({ accepted: true });
    } finally {
      await telemetry.shutdown();
      trace.disable();
      metrics.disable();
    }
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ outcome: "infra_failed" });
    expect(String(completions[0]!.result.error)).toMatch(/^session_open_failed:Failed to start Droid/);
    expect(source.heartbeat).toHaveBeenCalled();
    const spans = exporter.getFinishedSpans();
    const jobSpan = spans.find((span) => span.name === "runner.job");
    const sessionOpenSpan = spans.find((span) => span.name === "runner.session.open");
    expect(jobSpan).toBeDefined();
    expect(sessionOpenSpan).toBeDefined();
    expect(jobSpan?.attributes["forksafe.outcome"]).toBe("infra_failed");
    expect(sessionOpenSpan?.parentSpanContext?.spanId).toBe(jobSpan?.spanContext().spanId);
    expect(sessionOpenSpan?.attributes["error.type"]).toBe("DroidExecutableMissingError");
    expect(sessionOpenSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(sessionOpenSpan?.status.message).toBe("");
    expect(sessionOpenSpan?.events).toEqual([]);
    expect(JSON.stringify(sessionOpenSpan?.attributes)).not.toContain("executable not found");
  });
});
