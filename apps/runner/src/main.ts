import { hostname } from "node:os";
import { resolve } from "node:path";
import { context } from "@opentelemetry/api";
import {
  ActivityLog,
  SessionManager,
  UsageLedger,
  selectFactoryAdapter,
  factoryReadiness,
  type ForkSafeToolBackend,
  type ToolCallContext,
} from "@forksafe/agents";
import { EnvConfig } from "@forksafe/contracts";
import { initTelemetry } from "@forksafe/telemetry";
import { RunnerExecutor } from "./executor.js";
import { FileJobSource, HttpJobSource, isSearchCompleteRevocation } from "./job-source.js";
import { HttpToolBackend, LocalToolBackend } from "./tool-backend.js";
import type { Lease } from "./protocol.js";
import { RunnerTelemetry } from "./telemetry.js";

export class ActiveToolBackend implements ForkSafeToolBackend {
  private current: ForkSafeToolBackend;
  private subtaskHandler?: (input: Parameters<ForkSafeToolBackend["request_subtask"]>[0], ctx: Parameters<ForkSafeToolBackend["request_subtask"]>[1]) => Promise<unknown>;
  constructor(initial: ForkSafeToolBackend, private readonly telemetry: RunnerTelemetry) { this.current = initial; }
  set(backend: ForkSafeToolBackend) { this.current = backend; }
  setSubtaskHandler(handler: NonNullable<ActiveToolBackend["subtaskHandler"]>) { this.subtaskHandler = handler; }
  inspect_failure(...args: Parameters<ForkSafeToolBackend["inspect_failure"]>) { return this.invoke("inspect_failure", args, () => this.current.inspect_failure(...args)); }
  read_source(...args: Parameters<ForkSafeToolBackend["read_source"]>) { return this.invoke("read_source", args, () => this.current.read_source(...args)); }
  apply_patch(...args: Parameters<ForkSafeToolBackend["apply_patch"]>) { return this.invoke("apply_patch", args, () => this.current.apply_patch(...args)); }
  fork_candidate(...args: Parameters<ForkSafeToolBackend["fork_candidate"]>) { return this.invoke("fork_candidate", args, () => this.current.fork_candidate(...args)); }
  async request_subtask(input: Parameters<ForkSafeToolBackend["request_subtask"]>[0], ctx: Parameters<ForkSafeToolBackend["request_subtask"]>[1]) {
    return this.telemetry.withToolSpan("request_subtask", ctx.attemptId, async () => {
      const reservation = await this.current.request_subtask(input, ctx) as { status?: string };
      if (reservation.status !== "reserved" || !this.subtaskHandler) return reservation;
      const result = await this.subtaskHandler(input, ctx);
      const completer = (this.current as HttpToolBackend & { completeSubtask?: (context: typeof ctx, result: unknown) => Promise<void> }).completeSubtask;
      await completer?.call(this.current, ctx, result);
      return result;
    });
  }
  run_experiment(...args: Parameters<ForkSafeToolBackend["run_experiment"]>) { return this.invoke("run_experiment", args, () => this.current.run_experiment(...args), true); }
  propose_controller_revision(...args: Parameters<ForkSafeToolBackend["propose_controller_revision"]>) { return this.invoke("propose_controller_revision", args, () => this.current.propose_controller_revision(...args)); }
  submit_candidate(...args: Parameters<ForkSafeToolBackend["submit_candidate"]>) { return this.invoke("submit_candidate", args, () => this.current.submit_candidate(...args), true); }
  read_findings(...args: Parameters<ForkSafeToolBackend["read_findings"]>) { return this.invoke("read_findings", args, () => this.current.read_findings(...args)); }
  write_finding(...args: Parameters<ForkSafeToolBackend["write_finding"]>) { return this.invoke("write_finding", args, () => this.current.write_finding(...args)); }
  request_evidence(...args: Parameters<ForkSafeToolBackend["request_evidence"]>) { return this.invoke("request_evidence", args, () => this.current.request_evidence(...args)); }

  private invoke(
    name: string,
    args: unknown[],
    run: () => Promise<unknown>,
    countArtifact = false,
  ): Promise<unknown> {
    const toolContext = args.at(-1) as ToolCallContext;
    return this.telemetry.withToolSpan(name, toolContext.attemptId, run, countArtifact);
  }
}

export async function main(): Promise<void> {
  const env = EnvConfig.parse(process.env);
  const callbackSecret = env.RUNNER_CALLBACK_SECRET;
  const telemetry = initTelemetry({
    serviceName: "forksafe-runner",
    secrets: [env.FACTORY_API_KEY ?? "", callbackSecret ?? ""],
  });
  const runnerTelemetry = new RunnerTelemetry(telemetry);
  let sessions: SessionManager | undefined;
  const active = new Set<Promise<unknown>>();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const maxActiveModelCalls = env.MAX_ACTIVE_MODEL_CALLS;
    const jobSourceUrl = process.env.RUNNER_JOB_SOURCE_URL;
    const controlUrl = process.env.RUNNER_CONTROL_URL;
    if ((jobSourceUrl || controlUrl) && !callbackSecret) throw new Error("RUNNER_CALLBACK_SECRET is required for HTTP runner connections");
    const jobsDir = resolve(process.env.RUNNER_JOBS_DIR ?? "./var/runner");
    const workspaceRoot = resolve(process.env.RUNNER_WORKSPACE_ROOT ?? "./var/workspaces");
    const log = new ActivityLog({
      filePath: resolve("./var/runner/activity.jsonl"),
      secrets: [env.FACTORY_API_KEY ?? "", callbackSecret ?? ""],
    });
    const source = jobSourceUrl
      ? new HttpJobSource(jobSourceUrl, callbackSecret!, fetch, process.env.RUNNER_CREDENTIAL_ID)
      : new FileJobSource(jobsDir);
    const localBackend = new LocalToolBackend(resolve("./var/runner/local"));
    const activeBackend = new ActiveToolBackend(localBackend, runnerTelemetry);
    sessions = new SessionManager({
      adapter: selectFactoryAdapter(env),
      ledger: new UsageLedger({
        totalTokens: Number.isSafeInteger(Number(process.env.RUNNER_MAX_TOKENS_PER_INVESTIGATION))
          && Number(process.env.RUNNER_MAX_TOKENS_PER_INVESTIGATION) > 0
          ? Number(process.env.RUNNER_MAX_TOKENS_PER_INVESTIGATION)
          : 100_000,
      }),
      workspaceRoot,
      maxActiveTurns: maxActiveModelCalls,
      toolBackend: activeBackend,
      log,
      onSessionReady: async ({ attemptId, epoch, session }) =>
        "session" in source ? source.session({ attemptId, epoch, session }) : undefined,
      onTurnComplete: async (checkpoint) => {
        if ("checkpoint" in source) {
          await source.checkpoint({
            attemptId: checkpoint.attemptId, epoch: checkpoint.epoch,
            checkpoint: {
              investigationId: checkpoint.investigationId, environmentId: checkpoint.environmentId,
              jobId: checkpoint.jobId, attemptId: checkpoint.attemptId, epoch: checkpoint.epoch,
              sessionId: checkpoint.sessionId, vendorSessionId: checkpoint.vendorSessionId,
              role: checkpoint.role,
              turnIndex: checkpoint.turnIndex, tokenUsage: checkpoint.tokenUsage,
              ...(checkpoint.parentSessionId ? { parentSessionId: checkpoint.parentSessionId } : {}),
              ...(checkpoint.revisionHeadId ? { revisionHeadId: checkpoint.revisionHeadId } : {}),
            },
          });
        }
      },
    });
    activeBackend.setSubtaskHandler((input, context) => sessions!.runSubtask(input, context));
    const executor = new RunnerExecutor({
      sessions, source, log, telemetry: runnerTelemetry,
      beforeJob: (lease: Lease) => {
        activeBackend.set(controlUrl
          ? new HttpToolBackend(controlUrl, callbackSecret!, lease, fetch, Date.now, process.env.RUNNER_CREDENTIAL_ID)
          : localBackend);
      },
    });
    const readiness = factoryReadiness(env);
    process.stdout.write(`${JSON.stringify({
      workerId: process.env.RUNNER_WORKER_ID ?? `runner-${hostname()}-${process.pid}`,
      factory: readiness,
      telemetry: telemetry.mode,
      jobSource: jobSourceUrl ? "http" : "file",
      toolControl: controlUrl ? "http" : "local-blocked",
    })}\n`);

    const workerId = process.env.RUNNER_WORKER_ID ?? `runner-${hostname()}-${process.pid}`;
    while (!stopping) {
      const capacity = Math.max(0, maxActiveModelCalls - active.size);
      if (!capacity) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        continue;
      }
      const jobSpan = telemetry.startSpan("runner.job");
      const claimSpan = telemetry.startSpan("runner.claim", {}, jobSpan.context);
      let lease: Lease | null;
      try {
        lease = await context.with(claimSpan.context, () =>
          source.claim({ workerId, kinds: ["factory_session"], capacity }));
      } catch (error) {
        claimSpan.span.setAttribute("error.type", error instanceof Error ? error.name : "Error");
        claimSpan.end();
        jobSpan.end();
        if (isSearchCompleteRevocation(error)) {
          process.stdout.write(`${JSON.stringify({ event: "runner.shutdown", reason: "search_complete" })}\n`);
          break;
        }
        throw error;
      }
      if (!lease) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        continue;
      }
      claimSpan.end();
      jobSpan.span.setAttribute("forksafe.job_id", lease.job.id);
      jobSpan.span.setAttribute("forksafe.attempt_id", lease.attempt.id);
      process.stdout.write(`${JSON.stringify({ traceId: jobSpan.span.spanContext().traceId })}\n`);
      const task = executor.execute(lease, jobSpan.context)
        .catch(async (error) => {
          await log.record({
            atMs: Date.now(), investigationId: lease.job.investigationId,
            environmentId: lease.job.environmentId ?? "unknown", sessionId: "unknown",
            kind: "error", summary: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => active.delete(task));
      active.add(task);
    }
  } finally {
    await Promise.all(active);
    await sessions?.closeAll();
    await telemetry.shutdown();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
