import { describe, expect, it } from "vitest";
import { canonicalJson, PAYLOAD_SCHEMA, TRUSTED_KEYS_SCHEMA } from "../../services/evaluator/ts/verify-manifest.js";
import { loadTrustedKeys, verifySignedEvaluation } from "../lib/signedEvaluation.js";

const DOMAIN = new TextEncoder().encode("forksafe.evaluation_manifest.v1\u0000");
const ids = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  investigationId: "22222222-2222-4222-8222-222222222222",
  evaluatorAttemptId: "33333333-3333-4333-8333-333333333333",
};
const experimentId = "44444444-4444-4444-8444-444444444444";
const sha = "f".repeat(64);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hex = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest("SHA-256", bytes as BufferSource)).toString("hex");

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKey, keyId: `ed25519:${(await hex(publicKey)).slice(0, 16)}` };
}

function trustedJson(key: { publicKey: Uint8Array; keyId: string }) {
  return JSON.stringify({ schema: TRUSTED_KEYS_SCHEMA, keys: [{ keyId: key.keyId, publicKey: b64(key.publicKey), status: "active" }] });
}

async function signedDocument(key: Awaited<ReturnType<typeof keyPair>>, controllerSha256 = sha) {
  const docCase = {
    caseId: "public-01", suite: "public", status: "passed", failureKinds: [], firstFailure: null,
    completionTimeSec: 9.5, experimentId, traceSha256: "1".repeat(64), replaySha256: "2".repeat(64),
  };
  const cases = [{
    caseId: "public-01", suite: "public", status: "passed", failureKinds: [], completionTimeUs: 9_500_000,
    experimentId, traceSha256: "1".repeat(64), replaySha256: "2".repeat(64),
  }];
  const payload = {
    schema: PAYLOAD_SCHEMA, evaluatorVersion: "forksafe-evaluator/0.3.0", evaluatorCodeSha256: "a".repeat(64),
    simulatorSha256: "b".repeat(64), assetsSha256: "c".repeat(64), engineVersion: "3.17.0", manifestsLockSha256: "d".repeat(64),
    suites: { public: "e".repeat(64) }, candidate: { controllerSha256, bundleSha256: "0".repeat(64), files: [] },
    ...ids, caseFilter: null, status: "passed", exitCode: 0, cases,
    casesSha256: await hex(new TextEncoder().encode(canonicalJson(cases))),
    counts: { total: 1, passed: 1, failed: 0, invalid: 0 },
    isolation: { planProcess: "separate_process", network: "audit_hook_only", privilegeDrop: false, parentDumpable: false },
    createdAtMs: 1000, keyId: key.keyId,
  };
  const payloadBytes = new TextEncoder().encode(canonicalJson(payload));
  const signed = new Uint8Array(DOMAIN.length + payloadBytes.length);
  signed.set(DOMAIN);
  signed.set(payloadBytes, DOMAIN.length);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key.pair.privateKey, signed));
  return {
    schema: "forksafe.run_candidate.v1", status: "passed", exitCode: 0, controllerSha256, engineVersion: "3.17.0",
    assetsSha256: "c".repeat(64), evaluatorCodeSha256: "a".repeat(64), manifestSha256: { public: "e".repeat(64) }, ...ids,
    cases: [docCase],
    signedManifest: {
      schema: "forksafe.signed_evaluation_manifest.v1", algorithm: "ed25519", keyId: key.keyId,
      publicKey: b64(key.publicKey), payload: b64(payloadBytes), signature: b64(signature),
    },
  };
}

const expected = { ...ids, controllerSha256: sha, suite: "public" as const };

describe("signed evaluation manifests gate scoring", () => {
  it("accepts a manifest signed by a trusted key for this candidate", async () => {
    const key = await keyPair();
    const result = await verifySignedEvaluation(await signedDocument(key), expected, loadTrustedKeys({ FORKSAFE_EVAL_TRUSTED_KEYS: trustedJson(key) }));
    expect(result).toMatchObject({ ok: true, keyId: key.keyId, cases: [{ caseId: "public-01", status: "passed", completionTimeSec: 9.5, experimentId }] });
  });

  it("rejects a tampered document (case flipped after signing)", async () => {
    const key = await keyPair();
    const document = await signedDocument(key);
    document.cases[0]!.status = "failed";
    expect(await verifySignedEvaluation(document, expected, loadTrustedKeys({ FORKSAFE_EVAL_TRUSTED_KEYS: trustedJson(key) })))
      .toEqual({ ok: false, code: "document_mismatch" });
  });

  it("rejects a tampered signed payload", async () => {
    const key = await keyPair();
    const document = await signedDocument(key);
    const payload = JSON.parse(Buffer.from(document.signedManifest.payload, "base64").toString("utf8"));
    payload.status = "failed";
    document.signedManifest.payload = b64(new TextEncoder().encode(canonicalJson(payload)));
    expect(await verifySignedEvaluation(document, expected, loadTrustedKeys({ FORKSAFE_EVAL_TRUSTED_KEYS: trustedJson(key) })))
      .toEqual({ ok: false, code: "bad_signature" });
  });

  it("rejects an unsigned document", async () => {
    const key = await keyPair();
    const document = { ...(await signedDocument(key)), signedManifest: null };
    expect(await verifySignedEvaluation(document, expected, loadTrustedKeys({ FORKSAFE_EVAL_TRUSTED_KEYS: trustedJson(key) })))
      .toEqual({ ok: false, code: "unsigned" });
  });

  it("rejects a manifest signed by a key that is not trusted", async () => {
    const signer = await keyPair();
    const trusted = await keyPair();
    expect(await verifySignedEvaluation(await signedDocument(signer), expected, loadTrustedKeys({ FORKSAFE_EVAL_TRUSTED_KEYS: trustedJson(trusted) })))
      .toEqual({ ok: false, code: "unknown_key" });
  });

  it("rejects a manifest whose candidate sha differs from the submitted candidate", async () => {
    const key = await keyPair();
    const trusted = loadTrustedKeys({ FORKSAFE_EVAL_TRUSTED_KEYS: trustedJson(key) });
    const other = "9".repeat(64);
    expect(await verifySignedEvaluation(await signedDocument(key, other), expected, trusted)).toEqual({ ok: false, code: "candidate_sha_mismatch" });
    const lying = { ...(await signedDocument(key, other)), controllerSha256: sha };
    expect(await verifySignedEvaluation(lying, expected, trusted)).toEqual({ ok: false, code: "candidate_sha_mismatch" });
  });

  it("fails closed without trusted keys or with another candidate's identity", async () => {
    const key = await keyPair();
    const document = await signedDocument(key);
    expect(await verifySignedEvaluation(document, expected, loadTrustedKeys({}))).toEqual({ ok: false, code: "trusted_keys_missing" });
    expect(await verifySignedEvaluation(document, expected, loadTrustedKeys({ FORKSAFE_EVAL_TRUSTED_KEYS: "{bad" }))).toEqual({ ok: false, code: "trusted_keys_missing" });
    const trusted = loadTrustedKeys({ FORKSAFE_EVAL_TRUSTED_KEYS: trustedJson(key) });
    expect(await verifySignedEvaluation(document, { ...expected, candidateId: "55555555-5555-4555-8555-555555555555" }, trusted))
      .toEqual({ ok: false, code: "expectation_mismatch" });
    expect(await verifySignedEvaluation(document, { ...expected, suite: "withheld" }, trusted)).toEqual({ ok: false, code: "suite_mismatch" });
  });
});

describe("withheld manifest upload bytes", () => {
  it("re-serialises to exactly the bytes pinned in evaluation/manifests.lock.json", async () => {
    const withheld = (await import("../../evaluation/withheld/manifest.json")).default;
    const lock = (await import("../../evaluation/manifests.lock.json")).default;
    const bytes = new TextEncoder().encode(`${JSON.stringify(withheld, null, 2)}\n`);
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    expect(digest).toBe(lock.withheld);
  });
});
