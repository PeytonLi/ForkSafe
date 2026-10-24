import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { appId, assertUUID } from "./lib/validators.js";

const artifactKind = v.union(
  v.literal("trace"), v.literal("replay"), v.literal("controller_source"),
  v.literal("log"), v.literal("report"), v.literal("screenshot"),
);

export const insertCloudArtifact = internalMutation({
  args: {
    kind: artifactKind,
    sha256: v.string(),
    bytes: v.number(),
    investigationId: v.string(),
    attemptId: v.optional(v.string()),
    visibility: v.union(v.literal("internal"), v.literal("withheld")),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    assertUUID(args.investigationId, "investigationId");
    if (args.attemptId) assertUUID(args.attemptId, "attemptId");
    if (!/^[0-9a-f]{64}$/i.test(args.sha256)) throw new ConvexError("sha256_invalid");
    if (args.bytes < 0 || args.bytes > 8 * 1024 * 1024) throw new ConvexError("artifact_size_invalid");
    const existing = await ctx.db.query("artifacts")
      .withIndex("by_sha_investigation", (q) => q.eq("sha256", args.sha256).eq("investigationId", args.investigationId))
      .unique();
    if (existing) return { artifactId: existing.appId, duplicate: true };
    const appArtifactId = appId();
    const storageKey = String(args.storageId);
    await ctx.db.insert("artifacts", {
      appId: appArtifactId,
      kind: args.kind,
      sha256: args.sha256,
      bytes: args.bytes,
      storage: "convex",
      storageKey,
      ...(args.attemptId ? { producedByAttemptId: args.attemptId } : {}),
      createdAtMs: Date.now(),
      investigationId: args.investigationId,
      visibility: args.visibility,
      storageId: args.storageId,
    });
    return { artifactId: appArtifactId, duplicate: false };
  },
});

export const getByAppId = internalQuery({
  args: { artifactId: v.string() },
  handler: async (ctx, args) => await ctx.db.query("artifacts")
    .withIndex("by_appId", (q) => q.eq("appId", args.artifactId))
    .unique(),
});

export const markRevoked = internalMutation({
  args: { artifactId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("artifacts")
      .withIndex("by_appId", (q) => q.eq("appId", args.artifactId))
      .unique();
    if (!row) throw new ConvexError("artifact_not_found");
    await ctx.db.patch(row._id, { revokedAtMs: Date.now() });
    return { revoked: true };
  },
});
