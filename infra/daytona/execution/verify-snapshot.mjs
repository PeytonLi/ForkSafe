import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(resolve(root, "packages/integrations/daytona/package.json"));
const { Daytona } = require("@daytonaio/sdk");
const snapshotsPath = resolve(root, "infra/daytona/snapshots.json");
const snapshotNamePattern = /^forksafe-exec-v[23]$/;

async function main() {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY is required");
  }
  const snapshots = JSON.parse(await readFile(snapshotsPath, "utf8"));
  const expected = snapshots.execution;
  if (!snapshotNamePattern.test(expected?.name ?? "") || !expected.id) {
    throw new Error("execution snapshot is not built");
  }
  const client = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
  });
  const snapshot = await client.snapshot.get(expected.id);
  const state = String(snapshot.state).toLowerCase();
  if (snapshot.name !== expected.name || !["active", "ready"].includes(state)) {
    throw new Error("execution snapshot is not ready");
  }
  console.log(JSON.stringify({ name: snapshot.name, id: snapshot.id, state: snapshot.state }));
}

main().catch((error) => {
  console.error(`execution_snapshot_verification_failed:${error instanceof Error ? error.name : "unknown"}`);
  process.exitCode = 1;
});
