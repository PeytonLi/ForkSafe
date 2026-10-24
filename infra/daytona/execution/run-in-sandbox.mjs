import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(resolve(root, "packages/integrations/daytona/package.json"));
const { Daytona } = require("@daytonaio/sdk");
const snapshotsPath = resolve(root, "infra/daytona/snapshots.json");

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalPath(candidate) {
  let existing = candidate;
  const tail = [];
  while (true) {
    try {
      await access(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  return resolve(await realpath(existing), ...tail);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

function optionalOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return process.argv[index + 1];
}

function safeError(error) {
  const name = error instanceof Error ? error.name : "Error";
  let message = error instanceof Error ? error.message : String(error);
  const key = process.env.DAYTONA_API_KEY;
  if (key) message = message.replaceAll(key, "[REDACTED]");
  return { name, message };
}

function notFound(error) {
  if (!error || typeof error !== "object") return false;
  const value = error;
  const status = value.status ?? value.statusCode ?? value.response?.status;
  return status === 404 || /not.?found/i.test(`${value.name ?? ""} ${value.message ?? ""}`);
}

async function allSandboxes(client) {
  const result = [];
  for await (const sandbox of client.list()) result.push(sandbox);
  return result;
}

async function timedCommand(sandbox, command, timeoutSec = 300, captureOutput = false) {
  const started = Date.now();
  try {
    const result = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
    const commandResult = {
      exitCode: result.exitCode ?? 1,
      wallMs: Date.now() - started,
    };
    if (captureOutput) {
      commandResult.output = String(result.result ?? result.artifacts?.stdout ?? "").trim();
    }
    return commandResult;
  } catch (error) {
    return {
      exitCode: null,
      wallMs: Date.now() - started,
      error: safeError(error),
    };
  }
}

async function downloadDocument(sandbox, remotePath, localPath) {
  const bytes = await sandbox.fs.downloadFile(remotePath);
  await writeFile(localPath, Buffer.from(bytes), { mode: 0o600 });
  return JSON.parse(await readFile(localPath, "utf8"));
}

function verifyLocally(executable, args, python = false) {
  const env = {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    ...(python ? { PYTHONPATH: resolve(root, "services") } : {}),
  };
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
  });
  return {
    exitCode: result.status,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    error: result.error ? safeError(result.error) : null,
  };
}

function verified(result) {
  if (!result || result.exitCode !== 0 || result.error) return false;
  try {
    return JSON.parse(result.stdout).valid === true;
  } catch {
    return false;
  }
}

function caseSummary(document) {
  const cases = Array.isArray(document.cases) ? document.cases : [];
  return {
    status: document.status ?? null,
    exitCode: document.exitCode ?? null,
    error: document.error ?? null,
    evaluatorAttemptId: document.evaluatorAttemptId ?? null,
    caseCounts: {
      total: cases.length,
      passed: cases.filter((item) => item.status === "passed").length,
      failed: cases.filter((item) => item.status === "failed").length,
      invalid: cases.filter((item) => item.status === "invalid").length,
    },
    cases: cases.map((item) => ({
      caseId: item.caseId,
      status: item.status,
      caseWallSec: item.caseWallSec ?? item.metrics?.caseWallSec ?? null,
      failureKinds: item.failureKinds ?? [],
    })),
  };
}

async function main() {
  const outputDir = resolve(option("--out-dir"));
  const canonicalOutputDir = await canonicalPath(outputDir);
  const canonicalRoot = await realpath(root);
  if (isWithin(root, outputDir) || isWithin(canonicalRoot, canonicalOutputDir)) {
    throw new Error("--out-dir must be outside the repository");
  }
  await mkdir(outputDir, { recursive: true });

  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("DAYTONA_API_KEY is required");
  const snapshots = JSON.parse(await readFile(snapshotsPath, "utf8"));
  const snapshot = snapshots.execution;
  if (
    !/^forksafe-exec-v[23]$/.test(snapshot?.name ?? "") ||
    typeof snapshot.id !== "string" ||
    snapshot.id.length === 0
  ) {
    throw new Error("execution snapshot must be forksafe-exec-v2 or forksafe-exec-v3 with an id");
  }
  const signingKeyPath = optionalOption("--signing-key-file");
  const trustedKeysPath = optionalOption("--trusted-keys");
  const signingEnabled = snapshot.name === "forksafe-exec-v3" || Boolean(signingKeyPath || trustedKeysPath);
  if (signingEnabled && (!signingKeyPath || !trustedKeysPath)) {
    throw new Error("signed runs require --signing-key-file and --trusted-keys");
  }
  let signingKeyBytes = null;
  let trustedKeys = null;
  let signingKeyId = null;
  if (signingEnabled) {
    const keyInfo = await lstat(signingKeyPath);
    if (!keyInfo.isFile() || (keyInfo.mode & 0o077) !== 0) {
      throw new Error("signing key file must be a private regular file");
    }
    signingKeyBytes = await readFile(signingKeyPath);
    trustedKeys = JSON.parse(await readFile(trustedKeysPath, "utf8"));
    const activeKeys = Array.isArray(trustedKeys?.keys)
      ? trustedKeys.keys.filter((item) => item.status === "active")
      : [];
    if (activeKeys.length !== 1 || typeof activeKeys[0].keyId !== "string") {
      throw new Error("trusted keys must contain exactly one active signing key");
    }
    signingKeyId = activeKeys[0].keyId;
  }

  const baselineBytes = await readFile(resolve(root, "controllers/baseline/task_controller.py"));
  const referenceBytes = await readFile(
    resolve(root, "evaluation/reference_controller/task_controller.py"),
  );
  const withheldBytes = await readFile(resolve(root, "evaluation/withheld/manifest.json"));
  const baselineSha = createHash("sha256").update(baselineBytes).digest("hex");
  const referenceSha = createHash("sha256").update(referenceBytes).digest("hex");
  const operationId = randomUUID();
  const investigationId = randomUUID();
  const sandboxAttemptId = randomUUID();
  const baselineAttemptId = randomUUID();
  const referenceAttemptId = randomUUID();
  const remoteDir = `/home/forksafe/forksafe-run-${operationId}`;
  const remoteBaseline = `${remoteDir}/baseline_task_controller.py`;
  const remoteReference = `${remoteDir}/reference_task_controller.py`;
  const remoteWithheld = `${remoteDir}/withheld-manifest.json`;
  const remoteBaselineKey = `${remoteDir}/signing-baseline.key`;
  const remoteReferenceKey = `${remoteDir}/signing-reference.key`;
  const remoteBaselineReport = `${remoteDir}/baseline.json`;
  const remoteReferenceReport = `${remoteDir}/reference.json`;
  const localBaselineReport = resolve(outputDir, "baseline.json");
  const localReferenceReport = resolve(outputDir, "reference.json");
  const localBaselineManifest = resolve(outputDir, "baseline.manifest.json");
  const localReferenceManifest = resolve(outputDir, "reference.manifest.json");
  const localManifestLock = JSON.parse(
    await readFile(resolve(root, "evaluation/manifests.lock.json"), "utf8"),
  );
  const client = new Daytona({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL,
  });
  const summary = {
    snapshot: { name: snapshot.name, id: snapshot.id, state: snapshot.state ?? null },
    operationId,
    sandboxId: null,
    preflight: null,
    timingsMs: {
      create: null,
      createDirectory: null,
      uploads: {},
      uploadTotal: null,
      commands: {},
      download: null,
      delete: null,
    },
    exitCodes: {},
    idOutput: null,
    sudo: null,
    evaluatorAttemptIds: {
      baseline: baselineAttemptId,
      reference: referenceAttemptId,
    },
    runs: { baseline: null, reference: null },
    isolation: { baseline: null, reference: null },
    downloadedManifests: { baseline: null, reference: null },
    signing: signingEnabled
      ? {
          keyId: signingKeyId,
          baselineVerified: false,
          referenceVerified: false,
          keyFilesConsumed: false,
          verifiers: {
            baseline: { python: null, typescript: null },
            reference: { python: null, typescript: null },
          },
          downloadErrors: { baseline: null, reference: null },
        }
      : null,
    downloadedDocs: {
      baseline: null,
      reference: null,
    },
    deletion: {
      sandboxGone: false,
      getResult: null,
      listedLaneSandboxes: [],
      activeLaneSandboxesRemaining: null,
      confirmed: false,
    },
    error: null,
  };

  let sandbox = null;
  let failure = false;
  try {
    const listed = await allSandboxes(client);
    const nonDeleted = listed.filter(
      (item) => !["deleted", "destroyed"].includes(String(item.state).toLowerCase()),
    );
    const laneSandboxes = nonDeleted.filter(
      (item) => item.labels?.["forksafe.lane"] === "evaluator-security",
    );
    summary.preflight = {
      sandboxesSeen: listed.length,
      nonDeletedSandboxes: nonDeleted.length,
      evaluatorSecuritySandboxes: laneSandboxes.length,
    };
    if (laneSandboxes.length > 0) {
      throw new Error("preflight refused: an evaluator-security sandbox already exists");
    }
    if (nonDeleted.length >= 5) {
      throw new Error("preflight refused: organization already has at least five non-deleted sandboxes");
    }

    const createStarted = Date.now();
    sandbox = await client.create(
      {
        name: `forksafe-evaluator-security-${operationId}`,
        snapshot: snapshot.name,
        labels: {
          "forksafe.project": "forksafe",
          "forksafe.operation": operationId,
          "forksafe.purpose": "execution",
          "forksafe.investigation": investigationId,
          "forksafe.attempt": sandboxAttemptId,
          "forksafe.lane": "evaluator-security",
        },
        networkBlockAll: true,
        autoStopInterval: 15,
        autoDeleteInterval: 60,
      },
      { timeout: 300 },
    );
    summary.sandboxId = sandbox.id;
    await sandbox.waitUntilStarted(300);
    summary.timingsMs.create = Date.now() - createStarted;

    summary.timingsMs.commands.id = await timedCommand(sandbox, "id", 300, true);
    summary.exitCodes.id = summary.timingsMs.commands.id.exitCode;
    summary.idOutput = summary.timingsMs.commands.id.output ?? null;
    summary.timingsMs.commands.sudoCheck = await timedCommand(
      sandbox,
      "command -v sudo",
      300,
      true,
    );
    summary.exitCodes.sudoCheck = summary.timingsMs.commands.sudoCheck.exitCode;
    summary.sudo = {
      present: summary.exitCodes.sudoCheck === 0,
      output: summary.timingsMs.commands.sudoCheck.output ?? "",
    };

    const directoryStarted = Date.now();
    await sandbox.fs.createFolder(remoteDir, "700");
    summary.timingsMs.createDirectory = Date.now() - directoryStarted;

    const files = [
      ["baselineController", remoteBaseline, baselineBytes],
      ["referenceController", remoteReference, referenceBytes],
      ["withheldManifest", remoteWithheld, withheldBytes],
    ];
    for (const [name, remotePath, bytes] of files) {
      const uploadStarted = Date.now();
      await sandbox.fs.uploadFile(Buffer.from(bytes), remotePath, 120);
      summary.timingsMs.uploads[name] = Date.now() - uploadStarted;
    }
    if (signingEnabled) {
      const uploadStarted = Date.now();
      await sandbox.fs.uploadFile(Buffer.from(signingKeyBytes), remoteBaselineKey, 120);
      summary.timingsMs.uploads.baselineSigningKey = Date.now() - uploadStarted;
      const chmodResult = await timedCommand(sandbox, `chmod 600 ${remoteBaselineKey}`);
      summary.timingsMs.commands.baselineSigningKeyMode = chmodResult;
      summary.exitCodes.baselineSigningKeyMode = chmodResult.exitCode;
      if (chmodResult.exitCode !== 0) throw new Error("baseline signing key chmod failed");
    }
    summary.timingsMs.uploadTotal = Object.values(summary.timingsMs.uploads).reduce(
      (total, duration) => total + duration,
      0,
    );

    const baselineEnvironment = signingEnabled
      ? `FORKSAFE_EVAL_SIGNING_KEY_FILE=${remoteBaselineKey} FORKSAFE_REQUIRE_SIGNING=1 `
      : "";
    const baselineCommand = [
      `${baselineEnvironment}python`,
      "-m",
      "evaluator.run_candidate",
      "--controller",
      remoteBaseline,
      "--expected-sha256",
      baselineSha,
      "--suite",
      "public",
      "--evaluator-attempt-id",
      baselineAttemptId,
      "--investigation-id",
      investigationId,
      "--out",
      remoteBaselineReport,
    ].join(" ");
    summary.timingsMs.commands.baseline = await timedCommand(sandbox, baselineCommand, 600);
    summary.exitCodes.baseline = summary.timingsMs.commands.baseline.exitCode;
    if (signingEnabled) {
      summary.timingsMs.commands.baselineKeyExists = await timedCommand(
        sandbox,
        `test -e ${remoteBaselineKey}`,
      );
      summary.exitCodes.baselineKeyExists = summary.timingsMs.commands.baselineKeyExists.exitCode;
    }

    if (signingEnabled) {
      const uploadStarted = Date.now();
      await sandbox.fs.uploadFile(Buffer.from(signingKeyBytes), remoteReferenceKey, 120);
      summary.timingsMs.uploads.referenceSigningKey = Date.now() - uploadStarted;
      const chmodResult = await timedCommand(sandbox, `chmod 600 ${remoteReferenceKey}`);
      summary.timingsMs.commands.referenceSigningKeyMode = chmodResult;
      summary.exitCodes.referenceSigningKeyMode = chmodResult.exitCode;
      if (chmodResult.exitCode !== 0) throw new Error("reference signing key chmod failed");
    }
    const referenceEnvironment = signingEnabled
      ? `FORKSAFE_EVAL_SIGNING_KEY_FILE=${remoteReferenceKey} FORKSAFE_REQUIRE_SIGNING=1 `
      : "";
    const referenceCommand = [
      `${referenceEnvironment}python`,
      "-m",
      "evaluator.run_candidate",
      "--controller",
      remoteReference,
      "--expected-sha256",
      referenceSha,
      "--suite",
      "all",
      "--withheld-manifest",
      remoteWithheld,
      "--consume-withheld-manifest",
      "--evaluator-attempt-id",
      referenceAttemptId,
      "--investigation-id",
      investigationId,
      "--out",
      remoteReferenceReport,
    ].join(" ");
    summary.timingsMs.commands.reference = await timedCommand(sandbox, referenceCommand, 900);
    summary.exitCodes.reference = summary.timingsMs.commands.reference.exitCode;
    if (signingEnabled) {
      summary.timingsMs.commands.referenceKeyExists = await timedCommand(
        sandbox,
        `test -e ${remoteReferenceKey}`,
      );
      summary.exitCodes.referenceKeyExists = summary.timingsMs.commands.referenceKeyExists.exitCode;
    }

    summary.timingsMs.commands.withheldExists = await timedCommand(
      sandbox,
      `test -e ${remoteWithheld}`,
    );
    summary.exitCodes.withheldExists = summary.timingsMs.commands.withheldExists.exitCode;

    const downloadStarted = Date.now();
    let baselineDocument = null;
    let referenceDocument = null;
    let baselineManifest = null;
    let referenceManifest = null;
    try {
      baselineDocument = await downloadDocument(
        sandbox,
        remoteBaselineReport,
        localBaselineReport,
      );
      summary.downloadedDocs.baseline = localBaselineReport;
      summary.runs.baseline = caseSummary(baselineDocument);
      summary.isolation.baseline = baselineDocument.isolation ?? null;
      summary.evaluatorAttemptIds.baseline = baselineDocument.evaluatorAttemptId ?? baselineAttemptId;
    } catch (error) {
      summary.runs.baseline = { error: safeError(error), cases: [] };
    }
    try {
      referenceDocument = await downloadDocument(
        sandbox,
        remoteReferenceReport,
        localReferenceReport,
      );
      summary.downloadedDocs.reference = localReferenceReport;
      summary.runs.reference = caseSummary(referenceDocument);
      summary.isolation.reference = referenceDocument.isolation ?? null;
      summary.evaluatorAttemptIds.reference = referenceDocument.evaluatorAttemptId ?? referenceAttemptId;
    } catch (error) {
      summary.runs.reference = { error: safeError(error), cases: [] };
    }
    if (signingEnabled) {
      try {
        baselineManifest = await downloadDocument(
          sandbox,
          `${remoteBaselineReport.slice(0, -5)}.manifest.json`,
          localBaselineManifest,
        );
        summary.downloadedManifests.baseline = localBaselineManifest;
      } catch (error) {
        summary.signing.downloadErrors.baseline = safeError(error);
      }
      try {
        referenceManifest = await downloadDocument(
          sandbox,
          `${remoteReferenceReport.slice(0, -5)}.manifest.json`,
          localReferenceManifest,
        );
        summary.downloadedManifests.reference = localReferenceManifest;
      } catch (error) {
        summary.signing.downloadErrors.reference = safeError(error);
      }
      if (baselineDocument && baselineManifest) {
        const expectedArgs = [
          "--expect-controller-sha256",
          baselineSha,
          "--expect-public-manifest-sha256",
          localManifestLock.public,
          "--require-suite",
          "public",
        ];
        summary.signing.verifiers.baseline.python = verifyLocally(
          resolve(root, ".venv/bin/python"),
          [
            "-m",
            "evaluator.verify_manifest",
            "--manifest",
            localBaselineManifest,
            "--trusted-keys",
            trustedKeysPath,
            "--document",
            localBaselineReport,
            ...expectedArgs,
          ],
          true,
        );
        summary.signing.verifiers.baseline.typescript = verifyLocally(
          process.execPath,
          [
            "services/evaluator/ts/cli.ts",
            "--manifest",
            localBaselineManifest,
            "--trusted-keys",
            trustedKeysPath,
            "--document",
            localBaselineReport,
            ...expectedArgs,
          ],
        );
      }
      if (referenceDocument && referenceManifest) {
        const expectedArgs = [
          "--expect-controller-sha256",
          referenceSha,
          "--expect-public-manifest-sha256",
          localManifestLock.public,
          "--expect-withheld-manifest-sha256",
          localManifestLock.withheld,
          "--require-suite",
          "public",
          "--require-suite",
          "withheld",
        ];
        summary.signing.verifiers.reference.python = verifyLocally(
          resolve(root, ".venv/bin/python"),
          [
            "-m",
            "evaluator.verify_manifest",
            "--manifest",
            localReferenceManifest,
            "--trusted-keys",
            trustedKeysPath,
            "--document",
            localReferenceReport,
            ...expectedArgs,
          ],
          true,
        );
        summary.signing.verifiers.reference.typescript = verifyLocally(
          process.execPath,
          [
            "services/evaluator/ts/cli.ts",
            "--manifest",
            localReferenceManifest,
            "--trusted-keys",
            trustedKeysPath,
            "--document",
            localReferenceReport,
            ...expectedArgs,
          ],
        );
      }
      summary.signing.baselineVerified =
        verified(summary.signing.verifiers.baseline.python) &&
        verified(summary.signing.verifiers.baseline.typescript);
      summary.signing.referenceVerified =
        verified(summary.signing.verifiers.reference.python) &&
        verified(summary.signing.verifiers.reference.typescript);
      summary.signing.keyFilesConsumed =
        summary.exitCodes.baselineKeyExists === 1 &&
        summary.exitCodes.referenceKeyExists === 1;
    }
    summary.timingsMs.download = Date.now() - downloadStarted;

    const baselineOriginal = baselineDocument?.cases?.find(
      (item) => item.caseId === "original-divider-collision",
    );
    const baselineExpected =
      summary.exitCodes.baseline === 1 &&
      baselineDocument?.status === "failed" &&
      baselineDocument.cases?.length === 10 &&
      baselineOriginal?.status === "failed" &&
      baselineOriginal.failureKinds?.includes("forbidden_contact");
    const referenceExpected =
      summary.exitCodes.reference === 0 &&
      referenceDocument?.status === "passed" &&
      referenceDocument.cases?.length === 18 &&
      referenceDocument.cases.every((item) => item.status === "passed");
    const withheldConsumed = summary.exitCodes.withheldExists === 1;
    summary.expectedOutcomes = {
      baselineRegression: Boolean(baselineExpected),
      referenceAllPassed: Boolean(referenceExpected),
      withheldManifestConsumed: withheldConsumed,
      ...(signingEnabled
        ? {
            baselineVerified: summary.signing.baselineVerified,
            referenceVerified: summary.signing.referenceVerified,
            keyFilesConsumed: summary.signing.keyFilesConsumed,
          }
        : {}),
    };
  } catch (error) {
    failure = true;
    summary.error = safeError(error);
  } finally {
    const deleteStarted = Date.now();
    try {
      if (!sandbox) {
        const possible = await allSandboxes(client);
        sandbox =
          possible.find(
            (item) =>
              item.labels?.["forksafe.project"] === "forksafe" &&
              item.labels?.["forksafe.operation"] === operationId &&
              item.labels?.["forksafe.lane"] === "evaluator-security",
          ) ?? null;
      }
      if (sandbox) await sandbox.delete(60, true);
    } catch (error) {
      failure = true;
      summary.deletion.error = safeError(error);
    }
    summary.timingsMs.delete = Date.now() - deleteStarted;

    try {
      if (sandbox) {
        const getDeadline = Date.now() + 60_000;
        do {
          try {
            const current = await client.get(sandbox.id);
            summary.deletion.lastGetState = String(current?.state ?? "absent");
            if (!current) {
              summary.deletion.sandboxGone = true;
              summary.deletion.getResult = "absent";
              break;
            }
          } catch (error) {
            if (notFound(error)) {
              summary.deletion.sandboxGone = true;
              summary.deletion.getResult = "404";
              break;
            }
            summary.deletion.error = safeError(error);
            break;
          }
          if (Date.now() >= getDeadline) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        } while (true);
      }
      const remaining = (await allSandboxes(client)).filter(
        (item) => item.labels?.["forksafe.lane"] === "evaluator-security",
      );
      summary.deletion.listedLaneSandboxes = remaining.map((item) => ({
        id: item.id,
        state: String(item.state),
      }));
      summary.deletion.activeLaneSandboxesRemaining = remaining.filter(
        (item) => !["deleted", "destroyed"].includes(String(item.state).toLowerCase()),
      ).length;
      summary.deletion.confirmed = summary.deletion.sandboxGone;
    } catch (error) {
      failure = true;
      summary.deletion.error = safeError(error);
    }
  }

  const expected = summary.expectedOutcomes;
  const successful =
    !failure &&
    !summary.error &&
    expected?.baselineRegression &&
    expected?.referenceAllPassed &&
    expected?.withheldManifestConsumed &&
    (!signingEnabled ||
      (expected?.baselineVerified &&
        expected?.referenceVerified &&
        expected?.keyFilesConsumed)) &&
    summary.deletion.confirmed;
  console.log(JSON.stringify(summary, null, 2));
  if (!successful) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ error: safeError(error) }));
  process.exitCode = 1;
});
