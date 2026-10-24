import { randomUUID } from "node:crypto";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { loadDaytonaConfig, runnerNetworkPolicy, toDaytonaNetworkOptions } from "../src/config.js";

const hosts = [
  "api.factory.ai",
  "app.factory.ai",
  "giant-jellyfish-684.convex.site",
  "maincloud.spacetimedb.com",
  "pypi.org",
] as const;

async function main() {
  const config = loadDaytonaConfig();
  if (!config.apiKey) throw new Error("daytona_api_key_missing");

  const client = new Daytona({ apiKey: config.apiKey, apiUrl: config.apiUrl });
  const operationId = `egress-probe-${randomUUID()}`;
  const labels = {
    "forksafe.project": "forksafe",
    "forksafe.operation": operationId,
    "forksafe.purpose": "runner",
    "forksafe.investigation": operationId,
  };
  const networkOptions = toDaytonaNetworkOptions("runner", runnerNetworkPolicy(config));
  let sandbox: Sandbox | undefined;

  try {
    sandbox = await client.create({
      name: `forksafe-egress-probe-${randomUUID().slice(0, 8)}`,
      image: "curlimages/curl:8.10.1",
      resources: { cpu: 1, memory: 1, disk: 3 },
      labels,
      autoStopInterval: 5,
      autoDeleteInterval: 15,
      ttlMinutes: 30,
      ...networkOptions,
    }, { timeout: 600 });

    const rows: Array<{ host: string; reachable: boolean; code: string }> = [];
    for (const host of hosts) {
      let code = "000";
      try {
        const result = await sandbox.process.executeCommand(
          `curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://${host} 2>/dev/null`,
          undefined,
          undefined,
          15,
        );
        code = result.result?.match(/\b\d{3}\b/)?.[0] ?? "000";
      } catch {
        code = "000";
      }
      rows.push({ host, reachable: code !== "000", code });
    }

    console.log("host\t\t\t\tresult\thttp");
    for (const row of rows) {
      console.log(`${row.host.padEnd(36)}\t${row.reachable ? "reachable" : "blocked"}\t${row.code}`);
    }
  } finally {
    const owned = new Map<string, Sandbox>();
    if (sandbox) owned.set(sandbox.id, sandbox);
    let listingSucceeded = false;
    try {
      for await (const candidate of client.list({ labels })) {
        if (
          candidate.labels["forksafe.project"] === "forksafe"
          && candidate.labels["forksafe.operation"] === operationId
        ) {
          owned.set(candidate.id, candidate);
        }
      }
      listingSucceeded = true;
    } catch {
      if (!sandbox) process.exitCode = 1;
    }

    let cleanupFailed = false;
    for (const candidate of owned.values()) {
      try {
        await client.delete(candidate, 30, true);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed || (!listingSucceeded && !sandbox)) {
      console.error("daytona_egress_probe_cleanup_failed");
      process.exitCode = 1;
    } else if (owned.size > 0) {
      console.log("cleanup: deleted");
    }
  }
}

main().catch(() => {
  console.error("daytona_egress_probe_failed");
  process.exitCode = 1;
});
