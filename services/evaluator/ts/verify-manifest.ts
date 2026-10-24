export const ENVELOPE_SCHEMA = "forksafe.signed_evaluation_manifest.v1";
export const PAYLOAD_SCHEMA = "forksafe.evaluation_manifest.v1";
export const TRUSTED_KEYS_SCHEMA = "forksafe.evaluator_trusted_keys.v1";
const DOMAIN = new TextEncoder().encode("forksafe.evaluation_manifest.v1\u0000");
const TOKEN_CHAR = /^[A-Za-z0-9._:/+=@-]$/;

function validToken(value: string): boolean {
  return value.length <= 256 && [...value].every((char) => TOKEN_CHAR.test(char));
}

export class ManifestVerificationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ManifestVerificationError";
    this.code = code;
  }
}

export type TrustedKeyRecord = {
  publicKey: Uint8Array;
  status: "active" | "retired" | "revoked";
  retiredAtMs?: number;
};

export type TrustedKeySet = Map<string, TrustedKeyRecord>;
export type VerifiedEvaluationManifest = Record<string, unknown> & {
  keyId: string;
  status: string;
  cases: Array<Record<string, unknown>>;
  suites: Record<string, string>;
  casesSha256: string;
  counts: Record<string, number>;
  candidate: Record<string, unknown>;
};

function fail(code: string, message: string): never {
  throw new ManifestVerificationError(code, message);
}

function validateCanonical(value: unknown): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (!validToken(value)) throw new TypeError("invalid token string");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isFinite(value)) {
      throw new TypeError("canonical JSON does not support floats");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateCanonical(item);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (!validToken(key)) throw new TypeError("invalid token key");
      validateCanonical(item);
    }
    return;
  }
  throw new TypeError("unsupported canonical JSON value");
}

export function canonicalJson(value: unknown): string {
  validateCanonical(value);
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }
    return item;
  });
  if (encoded === undefined) throw new TypeError("unsupported canonical JSON value");
  return encoded;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("invalid base64");
  }
  const binary = atob(value);
  const result = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytesToBase64(result) !== value) throw new TypeError("non-canonical base64");
  return result;
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function keyId(publicKey: Uint8Array): Promise<string> {
  return `ed25519:${(await sha256(publicKey)).slice(0, 16)}`;
}

export function parseTrustedKeys(value: unknown): TrustedKeySet {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("bad_envelope", "trusted key set is invalid");
  }
  const source = value as Record<string, unknown>;
  if (source.schema !== TRUSTED_KEYS_SCHEMA || !Array.isArray(source.keys)) {
    fail("bad_envelope", "trusted key set is invalid");
  }
  const keys: TrustedKeySet = new Map();
  for (const entryValue of source.keys) {
    if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
      fail("bad_envelope", "trusted key set is invalid");
    }
    const entry = entryValue as Record<string, unknown>;
    const identifier = entry.keyId;
    const status = entry.status;
    let publicKey: Uint8Array;
    try {
      publicKey = decodeBase64(entry.publicKey);
    } catch {
      fail("bad_envelope", "trusted key set is invalid");
    }
    if (
      typeof identifier !== "string" ||
      publicKey.length !== 32 ||
      (status !== "active" && status !== "retired" && status !== "revoked") ||
      keys.has(identifier) ||
      (status === "retired" && !Number.isInteger(entry.retiredAtMs))
    ) {
      fail("bad_envelope", "trusted key set is invalid");
    }
    keys.set(identifier, {
      publicKey,
      status: status as TrustedKeyRecord["status"],
      ...(status === "retired" ? { retiredAtMs: entry.retiredAtMs as number } : {}),
    });
  }
  return keys;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function caseEntry(value: Record<string, unknown>): Record<string, unknown> {
  const completion = value.completionTimeSec;
  const completionTimeUs =
    completion === null || completion === undefined
      ? null
      : Math.floor((completion as number) * 1_000_000);
  return {
    caseId: value.caseId,
    suite: value.suite,
    status: value.status,
    failureKinds: Array.isArray(value.failureKinds)
      ? [...(value.failureKinds as string[])].sort()
      : [],
    completionTimeUs,
    experimentId: value.experimentId,
    traceSha256: value.traceSha256 ?? null,
    replaySha256: value.replaySha256 ?? null,
  };
}

function compareCases(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const suite = String(left.suite).localeCompare(String(right.suite));
  return suite || String(left.caseId).localeCompare(String(right.caseId));
}

function requiredPayload(payload: unknown): asserts payload is VerifiedEvaluationManifest {
  const value = asRecord(payload);
  const candidate = asRecord(value?.candidate);
  const required = [
    "schema", "evaluatorVersion", "evaluatorCodeSha256", "simulatorSha256",
    "assetsSha256", "engineVersion", "manifestsLockSha256", "suites", "candidate",
    "candidateId", "investigationId", "evaluatorAttemptId", "caseFilter", "status",
    "exitCode", "cases", "casesSha256", "counts", "isolation", "createdAtMs", "keyId",
  ];
  if (!value || required.some((field) => !(field in value)) || value.schema !== PAYLOAD_SCHEMA) {
    fail("bad_payload", "manifest payload has missing or invalid required fields");
  }
  if (!Number.isInteger(value.createdAtMs) || !Number.isInteger(value.exitCode)) {
    fail("bad_payload", "manifest payload has invalid scalar fields");
  }
  if (!Array.isArray(value.cases) || !asRecord(value.suites) || !candidate || !asRecord(value.counts)) {
    fail("bad_payload", "manifest payload has invalid collection fields");
  }
  try {
    validateCanonical(value);
  } catch {
    fail("bad_payload", "manifest payload has invalid fields");
  }
  for (const item of value.cases) {
    const itemRecord = asRecord(item);
    if (
      !itemRecord ||
      !["caseId", "suite", "status", "failureKinds", "completionTimeUs", "experimentId", "traceSha256", "replaySha256"].every((field) => field in itemRecord) ||
      !Array.isArray(itemRecord.failureKinds) ||
      !["passed", "failed", "invalid"].includes(String(itemRecord.status))
    ) {
      fail("bad_payload", "manifest payload contains an invalid case");
    }
  }
  if (
    typeof candidate.controllerSha256 !== "string" ||
    typeof candidate.bundleSha256 !== "string" ||
    !Array.isArray(candidate.files)
  ) {
    fail("bad_payload", "manifest payload candidate is invalid");
  }
  return;
}

async function verifyDocument(
  payload: VerifiedEvaluationManifest,
  document: Record<string, unknown>,
): Promise<void> {
  const expected: Record<string, unknown> = {
    assetsSha256: document.assetsSha256,
    evaluatorCodeSha256: document.evaluatorCodeSha256,
    candidateId: document.candidateId,
    investigationId: document.investigationId,
    evaluatorAttemptId: document.evaluatorAttemptId,
    status: document.status,
    exitCode: document.exitCode,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (payload[field] !== value) fail("document_mismatch", "signed manifest does not match run document");
  }
  if (payload.candidate.controllerSha256 !== document.controllerSha256) {
    fail("document_mismatch", "signed manifest does not match run document");
  }
  try {
    if (canonicalJson(payload.suites) !== canonicalJson(document.manifestSha256)) {
      fail("document_mismatch", "signed manifest does not match run document");
    }
  } catch (error) {
    if (error instanceof ManifestVerificationError) throw error;
    fail("document_mismatch", "signed manifest does not match run document");
  }
  if (!Array.isArray(document.cases)) fail("document_mismatch", "run document cases are invalid");
  const actual = document.cases
    .map((item) => caseEntry(asRecord(item) ?? {}))
    .sort(compareCases);
  if (canonicalJson(actual) !== canonicalJson(payload.cases)) {
    fail("document_mismatch", "signed cases do not match run document");
  }
}

export async function verifySignedManifest(
  envelopeValue: unknown,
  trusted: TrustedKeySet,
  options?: {
    expect?: Record<string, unknown>;
    document?: Record<string, unknown>;
  },
): Promise<VerifiedEvaluationManifest> {
  const envelope = asRecord(envelopeValue);
  if (!envelope || envelope.schema !== ENVELOPE_SCHEMA) {
    fail(envelopeValue === null || envelopeValue === undefined ? "unsigned" : "bad_envelope", "signed manifest envelope is invalid");
  }
  if (envelope.algorithm !== "ed25519") fail("unsupported_algorithm", "manifest signature algorithm is unsupported");
  let embedded: Uint8Array;
  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  try {
    embedded = decodeBase64(envelope.publicKey);
    payloadBytes = decodeBase64(envelope.payload);
    signature = decodeBase64(envelope.signature);
  } catch {
    fail("bad_envelope", "signed manifest envelope encoding is invalid");
  }
  if (typeof envelope.keyId !== "string") fail("bad_envelope", "signed manifest key id is invalid");
  const trustedRecord = trusted.get(envelope.keyId);
  if (!trustedRecord) fail("unknown_key", "manifest signing key is not trusted");
  if ((await keyId(trustedRecord.publicKey)) !== envelope.keyId) {
    fail("bad_envelope", "trusted key set is invalid");
  }
  if (bytesToBase64(embedded) !== bytesToBase64(trustedRecord.publicKey)) {
    fail("key_mismatch", "embedded key does not match trusted key");
  }
  if (trustedRecord.status === "revoked") fail("key_revoked", "manifest signing key is revoked");
  let payloadValue: unknown;
  try {
    payloadValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    fail("bad_payload", "manifest payload is invalid JSON");
  }
  let canonical: Uint8Array;
  try {
    canonical = new TextEncoder().encode(canonicalJson(payloadValue));
  } catch {
    fail("bad_payload", "manifest payload contains invalid values");
  }
  if (bytesToBase64(canonical) !== bytesToBase64(payloadBytes)) {
    fail("non_canonical_payload", "manifest payload is not canonical JSON");
  }
  requiredPayload(payloadValue);
  const payload = payloadValue;
  if (payload.keyId !== envelope.keyId) fail("key_mismatch", "manifest payload key does not match envelope");
  let signatureValid = false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      toArrayBuffer(embedded),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const signedBytes = new Uint8Array(DOMAIN.length + payloadBytes.length);
    signedBytes.set(DOMAIN);
    signedBytes.set(payloadBytes, DOMAIN.length);
    signatureValid = await globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      toArrayBuffer(signature),
      toArrayBuffer(signedBytes),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) fail("bad_signature", "manifest signature is invalid");
  if (
    trustedRecord.status === "retired" &&
    (payload.createdAtMs as number) > (trustedRecord.retiredAtMs ?? Number.NEGATIVE_INFINITY)
  ) {
    fail("key_retired", "manifest was signed after key retirement");
  }
  if (await sha256(new TextEncoder().encode(canonicalJson(payload.cases))) !== payload.casesSha256) {
    fail("cases_digest_mismatch", "signed cases digest does not match");
  }
  const cases = payload.cases as Array<Record<string, unknown>>;
  const counts = {
    total: cases.length,
    passed: cases.filter((item) => item.status === "passed").length,
    failed: cases.filter((item) => item.status === "failed").length,
    invalid: cases.filter((item) => item.status === "invalid").length,
  };
  if (canonicalJson(counts) !== canonicalJson(payload.counts)) {
    fail("bad_payload", "signed case counts do not match");
  }
  for (const [field, expected] of Object.entries(options?.expect ?? {})) {
    if (field === "suites") {
      const suites = asRecord(expected);
      if (!suites || Object.entries(suites).some(([suite, sha]) => payload.suites[suite] !== sha)) {
        fail("expectation_mismatch", "signed suite hashes do not match expectations");
      }
      continue;
    }
    const actual =
      field === "controllerSha256" || field === "bundleSha256"
        ? payload.candidate[field]
        : payload[field];
    if (
      ![
        "controllerSha256", "bundleSha256", "candidateId", "investigationId",
        "evaluatorAttemptId", "evaluatorCodeSha256", "assetsSha256", "manifestsLockSha256",
      ].includes(field) ||
      actual !== expected
    ) {
      fail("expectation_mismatch", `signed ${field} does not match expectation`);
    }
  }
  if (options?.document) await verifyDocument(payload, options.document);
  return payload;
}
