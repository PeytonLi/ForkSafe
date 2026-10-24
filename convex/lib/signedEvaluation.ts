import {
  ManifestVerificationError,
  parseTrustedKeys,
  verifySignedManifest,
  type TrustedKeySet,
} from "../../services/evaluator/ts/verify-manifest.js";

export type SignedCase = {
  caseId: string;
  suite: "public" | "withheld";
  status: "passed" | "failed" | "invalid";
  failureKinds: string[];
  completionTimeSec?: number;
  experimentId: string;
  firstFailure?: { kind: string; tSec: number; detail: string };
};

export type SignedEvaluationResult =
  | { ok: true; keyId: string; cases: SignedCase[]; engineVersion: string; assetsSha256: string; controllerSha256: string }
  | { ok: false; code: string };

export function loadTrustedKeys(env: Record<string, string | undefined> = process.env): TrustedKeySet | null {
  const raw = env.FORKSAFE_EVAL_TRUSTED_KEYS;
  if (!raw) return null;
  try {
    return parseTrustedKeys(JSON.parse(raw));
  } catch {
    return null;
  }
}

function signedCases(document: Record<string, unknown>): SignedCase[] {
  const cases = Array.isArray(document.cases) ? document.cases : [];
  return cases.map((value) => {
    const item = value as Record<string, unknown>;
    const failure = item.firstFailure as Record<string, unknown> | null | undefined;
    return {
      caseId: String(item.caseId),
      suite: item.suite === "withheld" ? "withheld" : "public",
      status: item.status === "passed" ? "passed" : item.status === "invalid" ? "invalid" : "failed",
      failureKinds: Array.isArray(item.failureKinds) ? item.failureKinds.map(String) : [],
      ...(typeof item.completionTimeSec === "number" && Number.isFinite(item.completionTimeSec) ? { completionTimeSec: item.completionTimeSec } : {}),
      experimentId: String(item.experimentId),
      ...(failure && typeof failure === "object" ? {
        firstFailure: {
          kind: String(failure.kind ?? "invalid_run"),
          tSec: typeof failure.tSec === "number" ? failure.tSec : 0,
          detail: String(failure.detail ?? "").slice(0, 500),
        },
      } : {}),
    };
  });
}

/** Verifies a run_candidate document's signed manifest before Convex scores it.
 *  Fails closed: no trusted keys, an unsigned or tampered document, an untrusted
 *  key, or any identity/sha mismatch returns ok:false and nothing is scored. */
export async function verifySignedEvaluation(
  document: unknown,
  expected: { candidateId: string; investigationId: string; evaluatorAttemptId: string; controllerSha256: string; suite: "public" | "withheld" },
  trusted: TrustedKeySet | null,
): Promise<SignedEvaluationResult> {
  if (!trusted || trusted.size === 0) return { ok: false, code: "trusted_keys_missing" };
  if (!document || typeof document !== "object" || Array.isArray(document)) return { ok: false, code: "bad_document" };
  const record = document as Record<string, unknown>;
  if (record.controllerSha256 !== expected.controllerSha256) return { ok: false, code: "candidate_sha_mismatch" };
  if (record.signedManifest === null || record.signedManifest === undefined) return { ok: false, code: "unsigned" };
  try {
    const payload = await verifySignedManifest(record.signedManifest, trusted, {
      expect: {
        controllerSha256: expected.controllerSha256,
        candidateId: expected.candidateId,
        investigationId: expected.investigationId,
        evaluatorAttemptId: expected.evaluatorAttemptId,
      },
      document: record,
    });
    const cases = signedCases(record);
    if (cases.length === 0 || cases.some((item) => item.suite !== expected.suite)) return { ok: false, code: "suite_mismatch" };
    return {
      ok: true,
      keyId: payload.keyId,
      cases,
      engineVersion: typeof record.engineVersion === "string" ? record.engineVersion : "unknown",
      assetsSha256: typeof payload.assetsSha256 === "string" ? payload.assetsSha256 : "0".repeat(64),
      controllerSha256: expected.controllerSha256,
    };
  } catch (error) {
    if (error instanceof ManifestVerificationError) {
      return { ok: false, code: error.code === "expectation_mismatch" && /controllerSha256/.test(error.message) ? "candidate_sha_mismatch" : error.code };
    }
    return { ok: false, code: "verification_failed" };
  }
}
