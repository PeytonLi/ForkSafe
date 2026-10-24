import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Daytona } from "@daytonaio/sdk";
import { initTelemetry } from "./index.js";

export function countPendingOutboxRows(output: string): number | undefined {
  try {
    return output.split(/\r?\n/).filter(Boolean).reduce((count, line) => {
      const row = JSON.parse(line) as { status?: unknown } | null;
      if (!row || typeof row !== "object" || typeof row.status !== "string") {
        throw new TypeError("Invalid outbox row");
      }
      return count + (row.status === "pending" ? 1 : 0);
    }, 0);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const telemetry = initTelemetry({ serviceName: "forksafe-ops" });
  let sandboxes: number | undefined;
  let outboxBacklog: number | undefined;
  let mode: "otlp" | "disabled" | "blocked" = telemetry.mode;
  const convexDir = resolve(fileURLToPath(new URL("../../../convex", import.meta.url)));

  if (process.env.DAYTONA_API_KEY) {
    try {
      const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
      let count = 0;
      for await (const sandbox of daytona.list({ labels: { "forksafe.project": "forksafe" } })) count += 1;
      sandboxes = count;
    } catch {
      mode = "blocked";
    }
  }

  if (process.env.CONVEX_DEPLOY_KEY) {
    try {
      const output = execFileSync("npx", [
        "convex", "data", "outbox", "--limit", "10000", "--format", "jsonl",
      ], { cwd: convexDir, encoding: "utf8", env: process.env });
      outboxBacklog = countPendingOutboxRows(output);
      if (outboxBacklog === undefined) mode = "blocked";
    } catch {
      mode = "blocked";
    }
  } else {
    mode = "blocked";
  }

  telemetry.metrics.setSandboxes(() => sandboxes);
  telemetry.metrics.setOutboxBacklog(() => outboxBacklog);
  await telemetry.metrics.forceFlush();
  process.stdout.write(`${JSON.stringify({ sandboxes, outboxBacklog, mode })}\n`);
  await telemetry.shutdown();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
