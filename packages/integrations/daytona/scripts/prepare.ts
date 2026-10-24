import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Daytona, Image } from "@daytonaio/sdk";
import { loadDaytonaConfig } from "../src/config.js";

const root = resolve(process.cwd(), "../../..");
const snapshotsPath = resolve(root, "infra/daytona/snapshots.json");
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const current = JSON.parse(await readFile(snapshotsPath, "utf8")) as Record<string, any>;
  const plan = Object.entries(current).map(([key, value]) => ({
    key,
    name: value.name,
    dockerfile: resolve(root, value.dockerfile),
    resources: value.resources,
  }));
  if (dryRun) {
    console.log(JSON.stringify({ mode: "dry_run", snapshots: plan.map(({ key, name, dockerfile, resources }) => ({ key, name, dockerfile, resources })) }, null, 2));
    return;
  }
  const config = loadDaytonaConfig();
  if (!config.apiKey) {
    console.error("blocked: DAYTONA_API_KEY is required");
    process.exitCode = 2;
    return;
  }
  const client = new Daytona({ apiKey: config.apiKey, apiUrl: config.apiUrl });

  const ownedSandboxes: string[] = [];
  for await (const sandbox of client.list({ labels: { "forksafe.project": "forksafe" } })) {
    if (sandbox.labels["forksafe.project"] === "forksafe") ownedSandboxes.push(sandbox.id);
  }
  if (ownedSandboxes.length > 0) {
    console.error(`blocked: ${ownedSandboxes.length} ForkSafe-labelled sandbox(es) already exist; clean them up before snapshot preparation`);
    process.exitCode = 2;
    return;
  }

  const existingSnapshots = await client.snapshot.list({ page: 1, limit: 100 });
  const forksafeSnapshots = existingSnapshots.items.filter((snapshot) => snapshot.name.startsWith("forksafe-"));
  if (forksafeSnapshots.length > 2) {
    console.error(`blocked: observed ${forksafeSnapshots.length} ForkSafe-named snapshots; refusing to build`);
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({
    quotaObservation: {
      forksafeActiveSandboxes: ownedSandboxes.length,
      forksafeNamedSnapshots: forksafeSnapshots.length,
      organizationQuotaEndpoint: "not exposed by installed @daytonaio/sdk 0.226.1 declarations",
      creationGuard: "refusing if existing ForkSafe sandbox count is nonzero or more than two ForkSafe-named snapshots exist",
    },
  }));

  for (const item of plan) {
    let snapshot: any = forksafeSnapshots.find((candidate) => candidate.name === item.name);
    if (!snapshot) {
      const image = Image.fromDockerfile(item.dockerfile);
      snapshot = await client.snapshot.create({
        name: item.name,
        image,
        resources: {
          cpu: item.resources.cpu,
          memory: item.resources.memory,
          disk: item.resources.disk,
        },
      }, { timeout: 1_800 });
      forksafeSnapshots.push(snapshot);
    } else {
      snapshot = await client.snapshot.get(item.name);
    }
    const startedAt = Date.now();
    while (!["active", "ready"].includes(String(snapshot.state).toLowerCase())) {
      if (Date.now() - startedAt > 1_800_000) throw new Error(`snapshot_build_timeout:${item.name}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
      snapshot = await client.snapshot.get(item.name);
    }
    current[item.key] = {
      ...current[item.key],
      id: snapshot.id,
      state: String(snapshot.state),
    };
    await writeFile(snapshotsPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ snapshot: item.name, id: snapshot.id, state: snapshot.state }));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]") : "unknown_error";
  console.error(`daytona_prepare_failed: ${message}`);
  process.exitCode = 1;
});
