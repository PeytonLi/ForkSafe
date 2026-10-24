import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  ManifestVerificationError,
  TRUSTED_KEYS_SCHEMA,
  parseTrustedKeys,
  verifySignedManifest,
} from "./verify-manifest.ts";

function parseArgs(argv: string[]): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--")) throw new Error("invalid argument");
    if (name === "--require-suite") {
      const value = argv[++index];
      if (value !== "public" && value !== "withheld") throw new Error("invalid suite");
      const current = result[name];
      result[name] = [...(Array.isArray(current) ? current : []), value];
    } else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("missing argument value");
      if (result[name] !== undefined) throw new Error("duplicate argument");
      result[name] = value;
    }
  }
  return result;
}

function stringArg(args: Record<string, string | string[]>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

async function run(): Promise<number> {
  let args: Record<string, string | string[]>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    process.stderr.write("usage: cli.ts --manifest P (--public-key B64 | --trusted-keys P) [--document P]\n");
    return 2;
  }
  const manifestPath = stringArg(args, "--manifest");
  const publicKey = stringArg(args, "--public-key");
  const trustedPath = stringArg(args, "--trusted-keys");
  if (!manifestPath || Boolean(publicKey) === Boolean(trustedPath)) {
    process.stderr.write("usage: cli.ts --manifest P (--public-key B64 | --trusted-keys P) [--document P]\n");
    return 2;
  }
  try {
    const manifestValue: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const documentPath = stringArg(args, "--document");
    let document: Record<string, unknown> | undefined;
    let envelope = manifestValue;
    if (manifestValue && typeof manifestValue === "object" && !Array.isArray(manifestValue) && "signedManifest" in manifestValue) {
      document = manifestValue as Record<string, unknown>;
      envelope = document.signedManifest;
    }
    if (documentPath) {
      const loaded: unknown = JSON.parse(await readFile(documentPath, "utf8"));
      if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) throw new Error("document invalid");
      document = loaded as Record<string, unknown>;
    }
    let trustedValue: unknown;
    if (publicKey) {
      const raw = Buffer.from(publicKey, "base64");
      if (raw.length !== 32 || raw.toString("base64") !== publicKey) throw new Error("public key invalid");
      const identifier = `ed25519:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
      trustedValue = {
        schema: TRUSTED_KEYS_SCHEMA,
        keys: [{ keyId: identifier, publicKey, status: "active" }],
      };
    } else {
      trustedValue = JSON.parse(await readFile(trustedPath as string, "utf8"));
    }
    const trusted = parseTrustedKeys(trustedValue);
    const expect: Record<string, unknown> = {};
    const hashExpectations: Array<[string, string]> = [
      ["--expect-controller-sha256", "controllerSha256"],
      ["--expect-bundle-sha256", "bundleSha256"],
    ];
    for (const [option, field] of hashExpectations) {
      const value = stringArg(args, option);
      if (value !== undefined) expect[field as string] = value;
    }
    const suites: Record<string, string> = {};
    const withheld = stringArg(args, "--expect-withheld-manifest-sha256");
    const publicSuite = stringArg(args, "--expect-public-manifest-sha256");
    if (withheld !== undefined) suites.withheld = withheld;
    if (publicSuite !== undefined) suites.public = publicSuite;
    if (Object.keys(suites).length) expect.suites = suites;
    const payload = await verifySignedManifest(envelope, trusted, {
      expect,
      ...(document ? { document } : {}),
    });
    const requiredSuites = args["--require-suite"];
    for (const suite of Array.isArray(requiredSuites) ? requiredSuites : []) {
      if (!(suite in payload.suites)) {
        throw new ManifestVerificationError("expectation_mismatch", "required suite is missing");
      }
    }
    process.stdout.write(`${JSON.stringify({
      valid: true,
      keyId: payload.keyId,
      status: payload.status,
      controllerSha256: payload.candidate.controllerSha256,
      bundleSha256: payload.candidate.bundleSha256,
      suites: payload.suites,
      casesSha256: payload.casesSha256,
      counts: payload.counts,
    })}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ManifestVerificationError ? error.code : "bad_envelope";
    const message = error instanceof Error ? error.message : "manifest verification failed";
    process.stdout.write(`${JSON.stringify({ valid: false, error: { code, message } })}\n`);
    return 3;
  }
}

process.exitCode = await run();
