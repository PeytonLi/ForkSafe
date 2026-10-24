import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFilesystemArtifactStore } from "../src/local.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local artifact storage", () => {
  it("checks hashes and round trips bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "forksafe-artifacts-"));
    dirs.push(root);
    const store = new LocalFilesystemArtifactStore(root);
    const bytes = new TextEncoder().encode("trace");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const stored = await store.put(bytes, {
      investigationId: crypto.randomUUID(), kind: "trace", visibility: "internal",
    });
    expect(stored.sha256).toBe(sha256);
    expect(await store.get(stored.id)).toEqual(bytes);
  });
});
