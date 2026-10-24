import type { ArtifactRef } from "@forksafe/contracts";
import type { ArtifactMetadata, ArtifactStore } from "./types.js";
import { sha256Hex } from "./utils.js";

export class ConvexHttpArtifactStore implements ArtifactStore {
  constructor(
    private readonly siteUrl: string,
    private readonly sharedSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(bytes: Uint8Array, meta: ArtifactMetadata): Promise<ArtifactRef> {
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("artifact_chunk_too_large");
    const response = await this.fetchImpl(new URL("/artifacts/upload", this.siteUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.sharedSecret}`,
        "content-type": "application/octet-stream",
        "x-forksafe-sha256": sha256Hex(bytes),
        "x-forksafe-kind": meta.kind,
        "x-forksafe-investigation": meta.investigationId,
        ...(meta.attemptId ? { "x-forksafe-attempt": meta.attemptId } : {}),
        "x-forksafe-visibility": meta.visibility ?? "internal",
      },
      body: Uint8Array.from(bytes).buffer as ArrayBuffer,
    });
    if (!response.ok) throw new Error(`artifact_upload_failed:${response.status}`);
    return await response.json() as ArtifactRef;
  }

  async get(idOrRef: string | ArtifactRef): Promise<Uint8Array> {
    const id = typeof idOrRef === "string" ? idOrRef : idOrRef.id;
    const response = await this.fetchImpl(new URL(`/artifacts/download?id=${encodeURIComponent(id)}`, this.siteUrl), {
      headers: { Authorization: `Bearer ${this.sharedSecret}` },
    });
    if (!response.ok) throw new Error(`artifact_download_failed:${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
