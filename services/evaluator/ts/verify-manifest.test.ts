import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import {
  ManifestVerificationError,
  PAYLOAD_SCHEMA,
  TRUSTED_KEYS_SCHEMA,
  canonicalJson,
  parseTrustedKeys,
  verifySignedManifest,
} from "./verify-manifest.ts";

const domain = new TextEncoder().encode("forksafe.evaluation_manifest.v1\u0000");

async function b64(bytes: Uint8Array): Promise<string> {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fixture() {
  const pair = (await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const keyId = `ed25519:${(await digest(publicKey)).slice(0, 16)}`;
  const payload = {
    schema: PAYLOAD_SCHEMA,
    evaluatorVersion: "forksafe-evaluator/0.3.0",
    evaluatorCodeSha256: "a".repeat(64),
    simulatorSha256: "b".repeat(64),
    assetsSha256: "c".repeat(64),
    engineVersion: "mujoco-3.17",
    manifestsLockSha256: "d".repeat(64),
    suites: { public: "e".repeat(64) },
    candidate: {
      controllerSha256: "f".repeat(64),
      bundleSha256: "0".repeat(64),
      files: [],
    },
    candidateId: "candidate-1",
    investigationId: "investigation-1",
    evaluatorAttemptId: "attempt-1",
    caseFilter: null,
    status: "passed",
    exitCode: 0,
    cases: [],
    casesSha256: await digest(new TextEncoder().encode("[]")),
    counts: { total: 0, passed: 0, failed: 0, invalid: 0 },
    isolation: {
      planProcess: "separate_process",
      network: "audit_hook_only",
      privilegeDrop: false,
      parentDumpable: false,
    },
    createdAtMs: 1000,
    keyId,
  };
  const payloadBytes = new TextEncoder().encode(canonicalJson(payload));
  const signed = new Uint8Array(domain.length + payloadBytes.length);
  signed.set(domain);
  signed.set(payloadBytes, domain.length);
  const signature = new Uint8Array(await webcrypto.subtle.sign("Ed25519", pair.privateKey, signed));
  const envelope = {
    schema: "forksafe.signed_evaluation_manifest.v1",
    algorithm: "ed25519",
    keyId,
    publicKey: await b64(publicKey),
    payload: await b64(payloadBytes),
    signature: await b64(signature),
  };
  const trusted = parseTrustedKeys({
    schema: TRUSTED_KEYS_SCHEMA,
    keys: [{ keyId, publicKey: await b64(publicKey), status: "active" }],
  });
  return { envelope, payload, trusted, publicKey, pair, keyId };
}

async function rejectsCode(
  envelope: unknown,
  trusted: ReturnType<typeof parseTrustedKeys>,
  code: string,
) {
  await assert.rejects(
    verifySignedManifest(envelope, trusted),
    (error: unknown) => error instanceof ManifestVerificationError && error.code === code,
  );
}

test("canonicalJson sorts keys and rejects unsupported values", () => {
  assert.equal(canonicalJson({ z: 1, a: [true, "x"] }), '{"a":[true,"x"],"z":1}');
  assert.throws(() => canonicalJson({ amount: 1.5 }));
  assert.throws(() => canonicalJson({ "not token": 1 }));
});

test("verifies a WebCrypto Ed25519 manifest and rejects signature tampering", async () => {
  const value = await fixture();
  const verified = await verifySignedManifest(value.envelope, value.trusted);
  assert.equal(verified.keyId, value.keyId);
  const changedPayload = { ...value.payload, status: "failed" };
  const payloadBytes = new TextEncoder().encode(canonicalJson(changedPayload));
  await rejectsCode(
    { ...value.envelope, payload: await b64(payloadBytes) },
    value.trusted,
    "bad_signature",
  );
  const signature = Uint8Array.from(atob(value.envelope.signature), (char) => char.charCodeAt(0));
  signature[0] = signature[0]! ^ 1;
  await rejectsCode(
    { ...value.envelope, signature: await b64(signature) },
    value.trusted,
    "bad_signature",
  );
});

test("rejects unknown, revoked, retired, and substituted keys", async () => {
  const value = await fixture();
  await rejectsCode({ ...value.envelope, keyId: "ed25519:unknown" }, value.trusted, "unknown_key");
  const revoked = parseTrustedKeys({
    schema: TRUSTED_KEYS_SCHEMA,
    keys: [{ keyId: value.keyId, publicKey: value.envelope.publicKey, status: "revoked" }],
  });
  await rejectsCode(value.envelope, revoked, "key_revoked");
  const retired = parseTrustedKeys({
    schema: TRUSTED_KEYS_SCHEMA,
    keys: [{
      keyId: value.keyId,
      publicKey: value.envelope.publicKey,
      status: "retired",
      retiredAtMs: 999,
    }],
  });
  await rejectsCode(value.envelope, retired, "key_retired");
  const attacker = (await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const attackerPublic = new Uint8Array(await webcrypto.subtle.exportKey("raw", attacker.publicKey));
  await rejectsCode(
    { ...value.envelope, publicKey: await b64(attackerPublic) },
    value.trusted,
    "key_mismatch",
  );
});

test("rejects a validly signed but non-canonical payload", async () => {
  const value = await fixture();
  const raw = new TextEncoder().encode(` ${canonicalJson(value.payload)} `);
  const signed = new Uint8Array(domain.length + raw.length);
  signed.set(domain);
  signed.set(raw, domain.length);
  const signature = new Uint8Array(await webcrypto.subtle.sign("Ed25519", value.pair.privateKey, signed));
  await rejectsCode(
    { ...value.envelope, payload: await b64(raw), signature: await b64(signature) },
    value.trusted,
    "non_canonical_payload",
  );
});
