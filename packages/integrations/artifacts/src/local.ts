import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ArtifactRef } from "@forksafe/contracts";
import type { ArtifactMetadata, ArtifactStore } from "./types.js";
import { sha256Hex } from "./utils.js";

export class LocalFsArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root = "./var/artifacts") {
    this.root = resolve(root);
  }

  async put(bytes: Uint8Array, meta: ArtifactMetadata): Promise<ArtifactRef> {
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("artifact_chunk_too_large");
    const sha256 = sha256Hex(bytes);
    const storageKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
    const contentPath = this.safePath(storageKey);
    const id = randomUUID();
    const ref: ArtifactRef = {
      id: id as ArtifactRef["id"],
      kind: meta.kind,
      sha256,
      bytes: bytes.byteLength,
      storage: "local_fs",
      storageKey,
      ...(meta.attemptId ? { producedByAttemptId: meta.attemptId as ArtifactRef["producedByAttemptId"] } : {}),
      createdAtMs: Date.now(),
    };
    const idPath = this.safePath(`ids/${id}.json`);
    await mkdir(dirname(contentPath), { recursive: true });
    await mkdir(dirname(idPath), { recursive: true });
    const temporary = `${contentPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, contentPath).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        await rm(temporary, { force: true });
      });
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await writeFile(idPath, JSON.stringify(ref), { mode: 0o600 });
    await writeFile(`${contentPath}.json`, JSON.stringify({
      ref,
      investigationId: meta.investigationId,
      visibility: meta.visibility ?? "internal",
    }), { mode: 0o600 });
    return ref;
  }

  async get(idOrRef: string | ArtifactRef): Promise<Uint8Array> {
    const storageKey = typeof idOrRef === "string"
      ? (await this.readRefById(idOrRef)).storageKey
      : idOrRef.storageKey;
    return new Uint8Array(await readFile(this.safePath(storageKey)));
  }

  async delete(idOrRef: string | ArtifactRef): Promise<void> {
    const ref = typeof idOrRef === "string" ? await this.readRefById(idOrRef) : idOrRef;
    await rm(this.safePath(`ids/${ref.id}.json`), { force: true });
    await rm(this.safePath(ref.storageKey), { force: true });
    await rm(this.safePath(`${ref.storageKey}.json`), { force: true });
  }

  private async readRefById(id: string): Promise<ArtifactRef> {
    return JSON.parse(await readFile(this.safePath(`ids/${id}.json`), "utf8")) as ArtifactRef;
  }

  private safePath(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}/`)) throw new Error("artifact_path_invalid");
    return path;
  }
}

export { LocalFsArtifactStore as LocalFilesystemArtifactStore };
