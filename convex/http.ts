import { httpRouter } from "convex/server";
import { httpAction, internalMutation } from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import { requireServiceToken } from "./lib/auth.js";

const router = httpRouter();
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

router.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async (ctx) => json(await ctx.runQuery(api.health.get, {}))),
});

router.route({
  path: "/artifacts/upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      requireServiceToken(bearerToken(request));
    } catch {
      return json({ error: "unauthorized" }, 401);
    }
    if (process.env.ARTIFACT_MODE === "local") {
      return json({ mode: "local", hint: "use LocalFsArtifactStore" }, 409);
    }
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_ARTIFACT_BYTES) return json({ error: "artifact_too_large" }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) return json({ error: "artifact_too_large" }, 413);
    const investigationId = request.headers.get("x-forksafe-investigation") ?? "";
    const kind = request.headers.get("x-forksafe-kind") ?? "";
    const attemptId = request.headers.get("x-forksafe-attempt") ?? undefined;
    const visibility = request.headers.get("x-forksafe-visibility") ?? "internal";
    if (!investigationId || !["trace", "replay", "controller_source", "log", "report", "screenshot"].includes(kind)) {
      return json({ error: "artifact_metadata_invalid" }, 400);
    }
    if (visibility !== "internal" && visibility !== "withheld") return json({ error: "visibility_invalid" }, 400);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const expected = request.headers.get("x-forksafe-sha256");
    if (!expected) return json({ error: "sha256_required" }, 400);
    if (expected.toLowerCase() !== sha256) return json({ error: "sha256_mismatch" }, 400);
    const storageId = await ctx.storage.store(new Blob([bytes]));
    const inserted = await ctx.runMutation(internal.artifacts.insertCloudArtifact, {
      kind: kind as "trace" | "replay" | "controller_source" | "log" | "report" | "screenshot",
      sha256,
      bytes: bytes.byteLength,
      investigationId,
      ...(attemptId ? { attemptId } : {}),
      visibility: visibility as "internal" | "withheld",
      storageId,
    });
    const now = Date.now();
    return json({
      id: inserted.artifactId,
      kind,
      sha256,
      bytes: bytes.byteLength,
      storage: "convex",
      storageKey: String(storageId),
      ...(attemptId ? { producedByAttemptId: attemptId } : {}),
      createdAtMs: now,
    });
  }),
});

router.route({
  path: "/artifacts/download",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      requireServiceToken(bearerToken(request));
    } catch {
      return json({ error: "unauthorized" }, 401);
    }
    const artifactId = new URL(request.url).searchParams.get("id");
    if (!artifactId) return json({ error: "artifact_id_required" }, 400);
    const artifact = await ctx.runQuery(internal.artifacts.getByAppId, { artifactId });
    if (!artifact) return json({ error: "artifact_not_found" }, 404);
    if (artifact.revokedAtMs) return json({ error: "artifact_revoked" }, 410);
    if (artifact.visibility === "withheld" && request.headers.get("x-forksafe-scope") !== "evaluator") {
      return json({ error: "artifact_forbidden" }, 403);
    }
    if (!artifact.storageId) return json({ error: "artifact_storage_missing" }, 404);
    const blob = await ctx.storage.get(artifact.storageId);
    if (!blob) return json({ error: "artifact_not_found" }, 404);
    return new Response(blob, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(artifact.bytes),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }),
});

router.route({
  path: "/callbacks/daytona",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      requireServiceToken(bearerToken(request));
    } catch {
      return json({ error: "unauthorized" }, 401);
    }
    const scheduled = await ctx.runMutation(internal.http.scheduleDaytonaReconcile, {});
    return json({ accepted: true, scheduled });
  }),
});

export const scheduleDaytonaReconcile = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.sandboxActions.reconcileSandbox, {});
    return true;
  },
});

export default router;
