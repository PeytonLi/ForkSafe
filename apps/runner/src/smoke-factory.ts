import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ActivityLog,
  LiveFactoryAdapter,
  SessionManager,
  UsageLedger,
  type ForkSafeToolBackend,
} from "@forksafe/agents";
import { LocalToolBackend } from "./tool-backend.js";

async function smoke(): Promise<void> {
  const apiKey = process.env.FACTORY_API_KEY;
  if (!apiKey) {
    process.stderr.write("blocked: FACTORY_API_KEY missing\n");
    process.exitCode = 1;
    return;
  }
  const baseDir = resolve("./var/smoke");
  const log = new ActivityLog({ secrets: [apiKey] });
  const backend: ForkSafeToolBackend = new LocalToolBackend(joinPath(baseDir, "local"));
  const manager = new SessionManager({
    adapter: new LiveFactoryAdapter({ apiKey }),
    ledger: new UsageLedger(),
    workspaceRoot: joinPath(baseDir, "workspaces"),
    toolBackend: backend,
    log,
  });
  const investigationId = randomUUID();
  const environmentId = randomUUID();
  const created = await manager.createSession({ investigationId, environmentId });
  let outputPath = "";
  try {
    const outcome = await manager.runTurn(
      created.sessionId,
      "Call the forksafe read_findings tool once with scope investigation, then reply with the number of findings it returned and the word DONE.",
    );
    const smokeRecord = {
      mode: outcome.mode,
      vendorSessionId: outcome.vendorRef.id,
      appSessionId: outcome.sessionId,
      success: outcome.success,
      toolCalls: outcome.toolCalls,
      tokenUsage: outcome.tokenUsage,
      durationMs: outcome.durationMs,
      sdkVersion: "0.10.0",
      droidVersion: execFileSync("droid", ["--version"], { encoding: "utf8" }).trim(),
    };
    await mkdir(baseDir, { recursive: true });
    outputPath = joinPath(baseDir, `factory-smoke-${Date.now()}.json`);
    await writeFile(outputPath, `${JSON.stringify(smokeRecord, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ path: outputPath, ...smokeRecord }, null, 2)}\n`);
  } catch (error) {
    const safeMessage = log.list().map((entry) => entry.summary).at(-1)
      ?? (error instanceof Error ? error.message.replaceAll(apiKey, "[REDACTED]") : String(error));
    const failure = {
      mode: "live",
      appSessionId: created.sessionId,
      success: false,
      errorClass: error instanceof Error ? error.name : "UnknownError",
      errorMessage: safeMessage.slice(0, 500),
      sdkVersion: "0.10.0",
    };
    await mkdir(baseDir, { recursive: true });
    outputPath = joinPath(baseDir, `factory-smoke-${Date.now()}.json`);
    await writeFile(outputPath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    process.stderr.write(`${JSON.stringify({ path: outputPath, ...failure }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await manager.closeAll();
  }
}

function joinPath(...parts: string[]): string {
  return resolve(...parts);
}

await smoke();
