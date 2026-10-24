import { delimiter, join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(packageDirectory, "../..");
const port = Number(process.env.MIGRATION_PORT ?? 3198);
const host = "127.0.0.1";
const serverUri = `http://${host}:${port}`;
const database = `forksafe-migration-${process.pid}-${randomBytes(3).toString("hex")}`;
const secret = randomBytes(32).toString("hex");
const oldRef = process.env.MIGRATION_BASE_REF ?? "origin/main";
const newModule = "working-tree";
const candidates = [
  ...((process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "spacetime"))),
  join(homedir(), ".local", "bin", "spacetime"),
];
const spacetime = candidates.find((candidate) => existsSync(candidate));
if (!spacetime) throw new Error("SpacetimeDB CLI not found in PATH or ~/.local/bin");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid MIGRATION_PORT: ${process.env.MIGRATION_PORT}`);
}

let server;
let temporaryDirectory;
let worktree;
let serverOutput = "";

function git(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stdout.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} exited ${result.status}`);
  return result.stdout.trim();
}

function cli(args, { cwd = repositoryRoot, env = {}, allowFailure = false } = {}) {
  const result = spawnSync(spacetime, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = (result.stdout ?? "").replaceAll(secret, "[REDACTED]");
  const stderr = (result.stderr ?? "").replaceAll(secret, "[REDACTED]");
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stdout.write(stderr);
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`spacetime ${args[0]} exited ${result.status}`);
  }
  return { status: result.status, output: `${stdout}\n${stderr}` };
}

function call(reducer, args, { cwd = repositoryRoot, allowFailure = false } = {}) {
  return cli(
    ["call", "--server", serverUri, database, reducer, ...Object.values(args).map((value) => JSON.stringify(value))],
    { cwd, allowFailure },
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForPort(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise((resolveConnection) => {
      const socket = createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolveConnection(true);
      });
      socket.once("error", () => resolveConnection(false));
    });
    if (connected) return;
    if (server?.exitCode !== null) throw new Error(`Local server exited early: ${serverOutput}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Local SpacetimeDB server did not open ${host}:${port}`);
}

async function assertPortFree() {
  const connected = await new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", () => resolveConnection(false));
  });
  if (connected) throw new Error(`Port ${port} is already in use; choose another MIGRATION_PORT`);
}

function stopServer() {
  if (!server?.pid || server.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    let timeout;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      resolveStop();
    };
    server.once("exit", finish);
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    timeout = setTimeout(() => {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        server.kill("SIGKILL");
      }
      finish();
    }, 5_000);
    timeout.unref();
  });
}

function baselineInput(id) {
  return {
    id,
    simCase: {
      case_id: "migration-check",
      suite: "public",
      seed: 1,
      scene_overrides_json: "{}",
      description: null,
    },
    sceneSha256: "a".repeat(64),
    controllerSha256: "b".repeat(64),
    assetsManifestSha256: "c".repeat(64),
    engineVersion: "migration-check",
    failureKinds: [],
    failureSummary: "Migration check baseline",
    sourceExperimentId: null,
    requirements: [],
  };
}

async function run() {
  await assertPortFree();
  temporaryDirectory = mkdtempSync(join(tmpdir(), "forksafe-migration-"));
  const dataDirectory = join(temporaryDirectory, "data");
  worktree = join(temporaryDirectory, "old-module");
  git(["worktree", "add", "--detach", worktree, oldRef]);
  symlinkSync(join(repositoryRoot, "node_modules"), join(worktree, "node_modules"), "dir");
  const oldModulePath = join(worktree, "packages", "spacetimedb");
  symlinkSync(join(packageDirectory, "node_modules"), join(oldModulePath, "node_modules"), "dir");

  server = spawn(
    spacetime,
    ["start", "--listen-addr", `${host}:${port}`, "--data-dir", dataDirectory, "--non-interactive"],
    { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
  );
  const logServer = (chunk) => {
    const text = chunk.toString().replaceAll(secret, "[REDACTED]");
    serverOutput += text;
    process.stdout.write(text);
  };
  server.stdout.on("data", logServer);
  server.stderr.on("data", logServer);
  await waitForPort();

  cli(
    ["publish", "--server", serverUri, "-y", "--module-path", oldModulePath, database],
    { env: { FORKSAFE_BRIDGE_SECRET: secret } },
  );
  call("register_bridge", { secret });

  const investigationId = randomUUID();
  const environmentId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const grantId = randomUUID();
  const grant = { grant_id: grantId, attempt_id: attemptId, epoch: 1 };
  const grantInput = {
    id: grantId,
    jobId,
    attemptId,
    epoch: 1,
    investigationId,
    environmentId: { some: environmentId },
    operations: ["heartbeat"],
    artifactPrefixes: [`inv/${investigationId}/`],
    maxBytes: 1000,
    expiresAtMs: Date.now() + 120_000,
  };
  call("install_grant", grantInput, { cwd: oldModulePath });
  call("heartbeat", { grant }, { cwd: oldModulePath });

  const oldRows = [
    cli(["sql", "--server", serverUri, "--format", "json", database, `SELECT * FROM job_fence WHERE job_id = '${jobId}'`]).output,
    cli(["sql", "--server", serverUri, "--format", "json", database, `SELECT * FROM execution_grant WHERE id = '${grantId}'`]).output,
    cli(["sql", "--server", serverUri, "--format", "json", database, `SELECT * FROM attempt_heartbeat WHERE attempt_id = '${attemptId}'`]).output,
  ];
  assert(
    oldRows.every((output, index) => output.includes([jobId, grantId, attemptId][index])),
    "Old reducers did not create all migration fixture rows",
  );

  const oldCommit = git(["rev-parse", oldRef]);
  const newCommit = git(["rev-parse", "HEAD"]);
  cli(
    ["publish", "--server", serverUri, "-y", "--module-path", packageDirectory, database],
    { env: { FORKSAFE_BRIDGE_SECRET: secret } },
  );

  const retainedRows = [
    cli(["sql", "--server", serverUri, "--format", "json", database, `SELECT * FROM job_fence WHERE job_id = '${jobId}'`]).output,
    cli(["sql", "--server", serverUri, "--format", "json", database, `SELECT * FROM execution_grant WHERE id = '${grantId}'`]).output,
    cli(["sql", "--server", serverUri, "--format", "json", database, `SELECT * FROM attempt_heartbeat WHERE attempt_id = '${attemptId}'`]).output,
  ];
  assert(retainedRows.every((output, index) => output.includes([jobId, grantId, attemptId][index])), "A pre-migration row was lost");

  const baselineId = randomUUID();
  call("register_baseline", baselineInput(baselineId));
  const newRows = cli(["sql", "--server", serverUri, "--format", "json", database, `SELECT * FROM baseline WHERE id = '${baselineId}'`]);
  assert(newRows.output.includes(baselineId), "A new reducer could not write after migration");
  console.log(`MIGRATION ${oldRef}@${oldCommit} -> ${newModule}@${newCommit}`);
  console.log("RETAINED job_fence, execution_grant, attempt_heartbeat; new register_baseline succeeded");
}

try {
  await run();
} catch (error) {
  process.stderr.write(`FAIL migration check: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await stopServer();
  if (worktree) {
    const result = spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stdout.write(result.stderr);
    if (result.status !== 0) process.exitCode = 1;
  }
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
