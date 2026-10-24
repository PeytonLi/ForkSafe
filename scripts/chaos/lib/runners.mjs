import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./convex.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsx = resolve(repoRoot, "apps/runner/node_modules/.bin/tsx");
const tsconfig = resolve(repoRoot, "apps/runner/tsconfig.json");
const probe = resolve(repoRoot, "scripts/chaos/runner-probe.ts");

function readRunnerRecords(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeRunnerRecords(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function redactRunnerOutput(text, secretValues) {
  let redacted = redactSecrets(text);
  for (const secret of secretValues) {
    if (secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function pipeRedactedOutput(stream, path, secretValues) {
  let pending = "";
  const retainedChars = Math.max(128, ...secretValues.map((secret) => secret.length));
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const flushLength = pending.length - retainedChars;
    if (flushLength > 0) {
      appendFileSync(path, redactRunnerOutput(pending.slice(0, flushLength), secretValues));
      pending = pending.slice(flushLength);
    }
  });
  stream.on("end", () => {
    if (pending) appendFileSync(path, redactRunnerOutput(pending, secretValues));
  });
}

export function activeTurnsAt(probeFiles, t = Infinity) {
  let total = 0;
  for (const path of probeFiles) {
    let active = 0;
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event.t === "number" && event.t > t) continue;
      if (event.ev === "acquired") active += 1;
      else if (event.ev === "released") active = Math.max(0, active - 1);
    }
    total += active;
  }
  return total;
}

export function isProcessGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function kill(runner, signal) {
  const pid = typeof runner === "number" ? runner : runner.pid;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function recordedRunners(workdir) {
  return readRunnerRecords(join(workdir, "runners.json"));
}

export async function listRunnerRecordFiles(root) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .map((item) => join(root, item.name, "runners.json"))
      .filter(existsSync);
  } catch {
    return [];
  }
}

export function startRunner({ envId, credential, workdir, tokenCap }) {
  if (!process.env.FACTORY_API_KEY) throw new Error("FACTORY_API_KEY is required to start a live Factory runner");
  const envShort = envId.slice(0, 8);
  const cwd = join(workdir, "runners", envShort);
  const filesDir = join(cwd, "var");
  mkdirSync(join(cwd, "agent"), { recursive: true });
  mkdirSync(join(filesDir, "runner"), { recursive: true });
  const probeFile = join(cwd, "probe.jsonl");
  const stdoutFile = join(cwd, "stdout.log");
  const stderrFile = join(cwd, "stderr.log");
  const recordsPath = join(workdir, "runners.json");
  const records = readRunnerRecords(recordsPath);
  const workerId = `chaos-${envShort}-${records.length + 1}`;
  writeFileSync(stdoutFile, "", { flag: "a", mode: 0o600 });
  writeFileSync(stderrFile, "", { flag: "a", mode: 0o600 });
  const child = spawn(tsx, ["--tsconfig", tsconfig, probe], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}`,
      HOME: homedir(),
      RUNNER_JOB_SOURCE_URL: "https://giant-jellyfish-684.convex.site",
      RUNNER_CONTROL_URL: "https://giant-jellyfish-684.convex.site",
      RUNNER_CALLBACK_SECRET: credential.secret,
      RUNNER_CREDENTIAL_ID: credential.credentialId,
      RUNNER_ENVIRONMENT_ID: envId,
      RUNNER_INVESTIGATION_ID: credential.investigationId,
      RUNNER_WORKER_ID: workerId,
      RUNNER_WORKSPACE_ROOT: join(cwd, "agent"),
      RUNNER_JOBS_DIR: filesDir,
      FACTORY_MODE: "cloud",
      FACTORY_API_KEY: process.env.FACTORY_API_KEY,
      MAX_ACTIVE_MODEL_CALLS: "2",
      RUNNER_MAX_TOKENS_PER_INVESTIGATION: String(tokenCap),
      CHAOS_PROBE_FILE: probeFile,
    },
  });
  if (!child.pid) throw new Error("Failed to start runner process");
  const secretValues = [
    credential.secret,
    process.env.FACTORY_API_KEY,
    process.env.CONVEX_DEPLOY_KEY,
    process.env.DAYTONA_API_KEY,
    process.env.INTEGRATION_SHARED_SECRET,
  ].filter(Boolean);
  pipeRedactedOutput(child.stdout, stdoutFile, secretValues);
  pipeRedactedOutput(child.stderr, stderrFile, secretValues);
  const runner = {
    pid: child.pid,
    envId,
    workerId,
    cwd,
    probeFile,
    stdoutFile,
    stderrFile,
    startedAtMs: Date.now(),
  };
  records.push(runner);
  writeRunnerRecords(recordsPath, records);
  child.unref();
  child.once("error", (error) => {
    appendFileSync(stderrFile, `${redactRunnerOutput(error?.message ?? error, secretValues)}\n`);
  });
  return runner;
}
