import type { GrantLike, LogicResult } from "./types.js";

export function checkArtifactScope(
  grant: Pick<GrantLike, "artifactPrefixes" | "bytesUsed" | "maxBytes">,
  storageKey: string,
  bytes: number,
): LogicResult<object> {
  if (
    storageKey.includes("..") ||
    !grant.artifactPrefixes.some((prefix) => storageKey.startsWith(prefix))
  ) {
    return { ok: false, code: "artifact_scope", message: "Artifact key is outside the grant prefixes" };
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0 || grant.bytesUsed + bytes > grant.maxBytes) {
    return { ok: false, code: "artifact_too_large", message: "Artifact exceeds the grant byte budget" };
  }
  return { ok: true };
}
