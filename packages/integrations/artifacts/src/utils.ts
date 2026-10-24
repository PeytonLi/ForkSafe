import { createHash } from "node:crypto";
import type { ArtifactChunk } from "./types.js";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function chunkBytes(bytes: Uint8Array, maxBytes = 8 * 1024 * 1024): ArtifactChunk[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
    throw new Error("invalid_artifact_chunk_size");
  }
  const total = Math.max(1, Math.ceil(bytes.byteLength / maxBytes));
  const groupSha256 = sha256Hex(bytes);
  return Array.from({ length: total }, (_, index) => ({
    bytes: bytes.slice(index * maxBytes, Math.min((index + 1) * maxBytes, bytes.byteLength)),
    index,
    total,
    groupSha256,
  }));
}
