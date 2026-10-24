import { constantTimeEqual } from "./auth.js";

export const RUNNER_SIGNATURE_MAX_SKEW_MS = 60_000;

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function randomSecret(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return hex(buffer.buffer);
}

export type RunnerSignatureHeaders = {
  credentialId?: string | null;
  timestamp?: string | null;
  signature?: string | null;
};

export type CredentialLike = { secret: string; expiresAtMs: number; revokedAtMs?: number };

/** Verifies `hex(HMAC-SHA256(secret, timestamp + "." + rawBody))` for a
 *  scoped runner credential. Fails closed on any missing piece. */
export async function verifyRunnerSignature(
  credential: CredentialLike | null,
  headers: RunnerSignatureHeaders,
  rawBody: string,
  now: number,
  options: { ignoreCredentialStatus?: boolean; ignoreRevocation?: boolean; ignoreExpiration?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: "missing_headers" | "unknown_credential" | "credential_expired" | "credential_revoked" | "timestamp_skew" | "bad_signature" }> {
  if (!headers.credentialId || !headers.timestamp || !headers.signature) return { ok: false, reason: "missing_headers" };
  if (!credential) return { ok: false, reason: "unknown_credential" };
  if (!options.ignoreCredentialStatus && !options.ignoreRevocation && credential.revokedAtMs !== undefined) return { ok: false, reason: "credential_revoked" };
  if (!options.ignoreCredentialStatus && !options.ignoreExpiration && credential.expiresAtMs <= now) return { ok: false, reason: "credential_expired" };
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > RUNNER_SIGNATURE_MAX_SKEW_MS) return { ok: false, reason: "timestamp_skew" };
  const expected = await hmacSha256Hex(credential.secret, `${headers.timestamp}.${rawBody}`);
  if (!constantTimeEqual(expected, headers.signature.toLowerCase())) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
