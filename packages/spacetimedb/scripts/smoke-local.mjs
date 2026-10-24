import { delimiter, join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const port = Number(process.env.PORT || 3197);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stdout.write(`FAIL local smoke: Invalid PORT: ${process.env.PORT}\n`);
  process.exit(1);
}
const host = "127.0.0.1";
const httpUri = `http://${host}:${port}`;
const dbName = `forksafe-smoke-${process.pid}-${randomBytes(3).toString("hex")}`;
const secret = randomBytes(32).toString("hex");
const uuid = () => randomUUID();
const sha = (seed) => seed.repeat(64).slice(0, 64);
const some = (value) => ({ some: value });

const candidates = [
  ...((process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "spacetime"))),
  join(homedir(), ".local", "bin", "spacetime"),
];
const spacetime = candidates.find((candidate) => existsSync(candidate));
if (!spacetime) {
  process.stdout.write("FAIL local smoke: SpacetimeDB CLI not found in PATH or ~/.local/bin\n");
  process.exit(1);
}

let server;
let serverDataDir;
let serverOutput = "";
const serverLog = (chunk) => {
  const text = chunk.toString();
  serverOutput += text;
  process.stdout.write(text);
};

function cli(args, { env = {}, allowFailure = false } = {}) {
  const result = spawnSync(spacetime, args, {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stdout.write(result.stderr);
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`spacetime ${args[0]} exited ${result.status}`);
  }
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function call(reducer, args, options = {}) {
  const reducerArgs = Object.values(args).map((value) => JSON.stringify(value));
  return cli(
    ["call", "--server", httpUri, dbName, reducer, ...reducerArgs],
    options,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectError(reducer, args, code) {
  const result = call(reducer, args, { allowFailure: true });
  assert(result.status !== 0, `${reducer} unexpectedly succeeded`);
  assert(result.output.includes(code), `${reducer} error did not include ${code}`);
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
    if (server?.exitCode !== null) {
      throw new Error(`Local server exited early: ${serverOutput}`);
    }
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
  if (connected) throw new Error(`Port ${port} is already in use; choose another PORT`);
}

function step(name, action) {
  return Promise.resolve()
    .then(action)
    .then(() => console.log(`PASS ${name}`))
    .catch((error) => {
      process.stdout.write(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    });
}

function stopServer() {
  if (!server?.pid) return Promise.resolve();
  if (server.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    let done = false;
    let timeout;
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

async function run() {
  let primaryGrant;
  let findingId;
  let investigationId;
  let environmentId;
  let artifactId;
  let revisionId;
  let candidateId;
  let outboxKey;
  const jobId = uuid();
  const attemptId = uuid();
  investigationId = uuid();
  environmentId = uuid();
  artifactId = uuid();
  revisionId = uuid();
  findingId = uuid();
  candidateId = uuid();
  const controllerSha = sha("a");
  const grantRef = () => ({ grant_id: primaryGrant, attempt_id: attemptId, epoch: 1 });
  const grantInput = (id, job, attempt, epoch, expiresAtMs) => ({
    id,
    jobId: job,
    attemptId: attempt,
    epoch,
    investigationId,
    environmentId: some(environmentId),
    operations: [
      "heartbeat",
      "acquire_revision_lease",
      "commit_revision",
      "record_artifact",
      "record_finding",
      "submit_candidate",
    ],
    artifactPrefixes: [`inv/${investigationId}/`],
    maxBytes: 1_000_000,
    expiresAtMs,
  });
  const findingInput = () => ({
    grant: grantRef(),
    id: findingId,
    investigationId,
    environmentId,
    sessionId: null,
    kind: "behavioral_note",
    claim: "observation",
    summary: "Stable turn",
    evidence: [
      {
        kind: "metric",
        artifact_id: some(artifactId),
        experiment_id: null,
        locator_json: '{"frame":42}',
        excerpt: some("stable"),
      },
    ],
    links: [],
  });
  const primaryExpiry = Date.now() + 120_000;

  await assertPortFree();
  serverDataDir = mkdtempSync(join(tmpdir(), "forksafe-spacetimedb-smoke-"));
  server = spawn(
    spacetime,
    [
      "start",
      "--listen-addr",
      `${host}:${port}`,
      "--data-dir",
      serverDataDir,
      "--in-memory",
      "--non-interactive",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
  );
  server.stdout.on("data", serverLog);
  server.stderr.on("data", serverLog);
  await waitForPort();

  await step("publish isolated in-memory database", () => {
    cli(
      ["publish", "--server", httpUri, "-y", "--module-path", ".", dbName],
      { env: { FORKSAFE_BRIDGE_SECRET: secret } },
    );
  });

  await step("reject incorrect bridge secret and register correct secret", () => {
    expectError("register_bridge", { secret: `${secret}wrong` }, "bridge_secret_mismatch");
    call("register_bridge", { secret });
  });

  await step("install scoped grant and record source artifact", () => {
    primaryGrant = uuid();
    call("install_grant", grantInput(primaryGrant, jobId, attemptId, 1, primaryExpiry));
    call("heartbeat", { grant: grantRef() });
    call("record_artifact", {
      grant: grantRef(),
      id: artifactId,
      kind: "controller_source",
      sha256: controllerSha,
      bytes: 128,
      storage: "local_fs",
      storageKey: `inv/${investigationId}/source/controller.ts`,
    });
  });

  await step("acquire lease and commit revision with expected-head conflict check", () => {
    call("acquire_revision_lease", { grant: grantRef(), environmentId });
    call("commit_revision", {
      grant: grantRef(),
      environmentId,
      revisionId,
      expectedHeadRevisionId: null,
      forkedFromRevisionId: null,
      controllerSha256: controllerSha,
      sourceArtifactId: artifactId,
      changedFunctions: ["steer"],
    });
    expectError(
      "commit_revision",
      {
        grant: grantRef(),
        environmentId,
        revisionId: uuid(),
        expectedHeadRevisionId: some(uuid()),
        forkedFromRevisionId: null,
        controllerSha256: controllerSha,
        sourceArtifactId: artifactId,
        changedFunctions: ["steer"],
      },
      "revision_conflict",
    );
  });

  await step("record finding, evidence, and its provenance outbox entry", () => {
    call("record_finding", findingInput());
    outboxKey = `finding:${findingId}:elastic_index`;
    const sql = cli(["sql", "--server", httpUri, "--format", "json", dbName, "SELECT * FROM finding"]);
    assert(sql.output.includes(findingId), "SQL assertion could not find recorded finding");
    assert(sql.output.includes("Stable turn"), "SQL assertion could not find finding summary");
    const evidence = cli(["sql", "--server", httpUri, "--format", "json", dbName, "SELECT * FROM evidence"]);
    assert(evidence.output.includes(findingId), "SQL assertion could not find linked evidence");
    const outbox = cli(["sql", "--server", httpUri, "--format", "json", dbName, "SELECT * FROM outbox_entry"]);
    assert(outbox.output.includes(outboxKey), "SQL assertion could not find provenance outbox entry");
    assert(outbox.output.includes("pending"), "SQL assertion could not confirm pending outbox status");
  });

  await step("submit immutable candidate and reject a changed hash", () => {
    const candidate = {
      grant: grantRef(),
      id: candidateId,
      investigationId,
      environmentId,
      revisionId: some(revisionId),
      controllerSha256: controllerSha,
      sourceArtifactId: artifactId,
      changedFunctions: ["steer"],
      rationale: some("Candidate from the committed source"),
      basedOnFindings: [findingId],
    };
    call("submit_candidate", candidate);
    expectError(
      "submit_candidate",
      { ...candidate, controllerSha256: sha("b") },
      "immutable_candidate",
    );
  });

  await step("reject superseded, revoked, and expired grants atomically", async () => {
    const replacement = uuid();
    const replacementAttempt = uuid();
    call("install_grant", grantInput(replacement, jobId, replacementAttempt, 2, Date.now() + 120_000));
    expectError("record_finding", findingInput(), "grant_superseded");
    call("revoke_grant", { grantId: replacement, reason: "smoke test revocation" });
    expectError(
      "heartbeat",
      { grant: { grant_id: replacement, attempt_id: replacementAttempt, epoch: 2 } },
      "grant_revoked",
    );

    const expiredId = uuid();
    const expiredAttempt = uuid();
    call("install_grant", grantInput(expiredId, uuid(), expiredAttempt, 1, Date.now() + 1_500));
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    expectError(
      "heartbeat",
      { grant: { grant_id: expiredId, attempt_id: expiredAttempt, epoch: 1 } },
      "grant_expired",
    );
  });

  await step("mark outbox failure then successful delivery", () => {
    call("outbox_mark_failed", { idempotencyKey: outboxKey, error: "temporary failure" });
    call("outbox_mark_delivered", { idempotencyKey: outboxKey });
    const sql = cli([
      "sql",
      "--server",
      httpUri,
      "--format",
      "json",
      dbName,
      `SELECT * FROM outbox_entry WHERE idempotency_key = '${outboxKey}'`,
    ]);
    assert(sql.output.includes("delivered"), "SQL assertion could not confirm outbox delivery");
  });

  await step("TypeScript client connection, subscription, and contract decoding", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/client-smoke.ts"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SPACETIMEDB_URI: `ws://${host}:${port}`,
        SPACETIMEDB_DATABASE: dbName,
        SMOKE_FINDING_ID: findingId,
        SMOKE_INVESTIGATION_ID: investigationId,
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stdout.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`TypeScript client smoke exited ${result.status}`);
  });
}

try {
  await run();
} catch (error) {
  process.stdout.write(`FAIL local smoke: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await stopServer();
  if (serverDataDir) rmSync(serverDataDir, { recursive: true, force: true });
}
