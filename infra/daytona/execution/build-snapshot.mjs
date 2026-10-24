import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(resolve(root, "packages/integrations/daytona/package.json"));
const { Daytona, Image } = require("@daytonaio/sdk");
const contextIndex = process.argv.indexOf("--context");
const contextPath = contextIndex < 0 ? undefined : process.argv[contextIndex + 1];
if (!contextPath) {
  throw new Error("--context DIR is required");
}
const context = resolve(contextPath);
const snapshotsPath = resolve(root, "infra/daytona/snapshots.json");
const snapshotNamePattern = /^forksafe-exec-v[23]$/;

async function main() {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY is required");
  }
  const snapshots = JSON.parse(await readFile(snapshotsPath, "utf8"));
  const execution = snapshots.execution;
  if (
    !snapshotNamePattern.test(execution?.name ?? "") ||
    execution.dockerfile !== "infra/daytona/execution/Dockerfile"
  ) {
    throw new Error("execution snapshot configuration is invalid");
  }
  const client = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
  });
  const snapshotName = execution.name;
  const dockerfile = resolve(context, "Dockerfile");
  const existing = (await client.snapshot.list({ page: 1, limit: 100 })).items.find(
    (item) => item.name === snapshotName,
  );
  if (existing && snapshotName === "forksafe-exec-v3") {
    throw new Error("forksafe-exec-v3 already exists; refusing to reuse a possibly stale image");
  }
  let snapshot = existing
    ? await client.snapshot.get(existing.id)
    : await client.snapshot.create(
        {
          name: snapshotName,
          image: Image.fromDockerfile(dockerfile),
          resources: {
            cpu: execution.resources.cpu,
            memory: execution.resources.memory,
            disk: execution.resources.disk,
          },
        },
        { timeout: 1_800, onLogs: (chunk) => process.stdout.write(chunk) },
      );
  const startedAt = Date.now();
  while (!["active", "ready"].includes(String(snapshot.state).toLowerCase())) {
    if (Date.now() - startedAt > 1_800_000) {
      throw new Error("snapshot build timed out");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    snapshot = await client.snapshot.get(snapshot.id);
  }
  snapshots.execution = {
    ...execution,
    id: snapshot.id,
    state: String(snapshot.state),
  };
  await writeFile(snapshotsPath, `${JSON.stringify(snapshots, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ name: snapshot.name, id: snapshot.id, state: snapshot.state }));
}

main().catch((error) => {
  console.error(`execution_snapshot_build_failed:${error instanceof Error ? error.name : "unknown"}`);
  process.exitCode = 1;
});
