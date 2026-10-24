import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  ActivityLog,
  SessionManager,
  UsageLedger,
  selectFactoryAdapter,
  factoryReadiness,
  type ForkSafeToolBackend,
} from "@forksafe/agents";
import { EnvConfig } from "@forksafe/contracts";
import { RunnerExecutor } from "./executor.js";
import { FileJobSource, HttpJobSource } from "./job-source.js";
import { HttpToolBackend, LocalToolBackend } from "./tool-backend.js";
import type { Lease } from "./protocol.js";

class ActiveToolBackend implements ForkSafeToolBackend {
  private current: ForkSafeToolBackend;
  constructor(initial: ForkSafeToolBackend) { this.current = initial; }
  set(backend: ForkSafeToolBackend) { this.current = backend; }
  run_experiment(...args: Parameters<ForkSafeToolBackend["run_experiment"]>) { return this.current.run_experiment(...args); }
  propose_controller_revision(...args: Parameters<ForkSafeToolBackend["propose_controller_revision"]>) { return this.current.propose_controller_revision(...args); }
  submit_candidate(...args: Parameters<ForkSafeToolBackend["submit_candidate"]>) { return this.current.submit_candidate(...args); }
  read_findings(...args: Parameters<ForkSafeToolBackend["read_findings"]>) { return this.current.read_findings(...args); }
  write_finding(...args: Parameters<ForkSafeToolBackend["write_finding"]>) { return this.current.write_finding(...args); }
  request_evidence(...args: Parameters<ForkSafeToolBackend["request_evidence"]>) { return this.current.request_evidence(...args); }
}

export async function main(): Promise<void> {
  const env = EnvConfig.parse(process.env);
  const maxActiveModelCalls = env.MAX_ACTIVE_MODEL_CALLS;
  const jobSourceUrl = process.env.RUNNER_JOB_SOURCE_URL;
  const controlUrl = process.env.RUNNER_CONTROL_URL;
  const callbackSecret = env.RUNNER_CALLBACK_SECRET;
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
  const activeBackend = new ActiveToolBackend(localBackend);
  const sessions = new SessionManager({
    adapter: selectFactoryAdapter(env),
    ledger: new UsageLedger(),
    workspaceRoot,
    maxActiveTurns: maxActiveModelCalls,
    toolBackend: activeBackend,
    log,
  });
  const executor = new RunnerExecutor({
    sessions, source, log,
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
    jobSource: jobSourceUrl ? "http" : "file",
    toolControl: controlUrl ? "http" : "local-blocked",
  })}\n`);

  const workerId = process.env.RUNNER_WORKER_ID ?? `runner-${hostname()}-${process.pid}`;
  const active = new Set<Promise<unknown>>();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      const capacity = Math.max(0, maxActiveModelCalls - active.size);
      if (!capacity) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        continue;
      }
      const lease = await source.claim({ workerId, kinds: ["factory_session"], capacity });
      if (!lease) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        continue;
      }
      let task: Promise<unknown>;
      task = executor.execute(lease)
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
    await sessions.closeAll();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
