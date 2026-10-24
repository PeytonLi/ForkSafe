import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server.js";
import { requireUiAccess } from "./lib/auth.js";

const bundleKey = v.union(v.literal("runner"), v.literal("simulator"), v.literal("baseline_controller"));

export const get = internalQuery({
  args: { key: bundleKey },
  handler: async (ctx, args) => await ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", args.key)).unique(),
});

export const record = internalMutation({
  args: { key: bundleKey, storageId: v.id("_storage"), sha256: v.string(), bytes: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!/^[0-9a-f]{64}$/.test(args.sha256)) throw new ConvexError("sha256_invalid");
    const existing = await ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    const row = { key: args.key, storageId: args.storageId, sha256: args.sha256, bytes: args.bytes, uploadedAtMs: Date.now(), ...(args.note ? { note: args.note } : {}) };
    if (existing) {
      if (existing.sha256 === args.sha256) return { duplicate: true };
      await ctx.db.patch(existing._id, row);
      return { duplicate: false, replaced: true };
    }
    await ctx.db.insert("bundles", row);
    return { duplicate: false, replaced: false };
  },
});

/** Large bundles (the simulator tar) bypass the 64 MB HTTP-action limit via a storage upload URL. */
export const createUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const recordUploaded = internalMutation({
  args: { key: bundleKey, storageId: v.id("_storage"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const metadata = await ctx.storage.getMetadata(args.storageId);
    if (!metadata) throw new ConvexError("storage_object_missing");
    const sha256 = /^[0-9a-f]{64}$/i.test(metadata.sha256)
      ? metadata.sha256.toLowerCase()
      : [...Uint8Array.from(atob(metadata.sha256), (char) => char.charCodeAt(0))].map((value) => value.toString(16).padStart(2, "0")).join("");
    const existing = await ctx.db.query("bundles").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    const row = { key: args.key, storageId: args.storageId, sha256, bytes: metadata.size, uploadedAtMs: Date.now(), ...(args.note ? { note: args.note } : {}) };
    if (existing && existing.sha256 === sha256) return { duplicate: true, sha256, bytes: metadata.size };
    if (existing) await ctx.db.patch(existing._id, row); else await ctx.db.insert("bundles", row);
    return { duplicate: false, replaced: Boolean(existing), sha256, bytes: metadata.size };
  },
});

export const recordBaselineSource = internalMutation({
  args: { controllerSha256: v.string(), artifactId: v.string(), source: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("controllerSources").withIndex("by_sha", (q) => q.eq("controllerSha256", args.controllerSha256)).unique();
    if (existing) return { duplicate: true };
    await ctx.db.insert("controllerSources", {
      controllerSha256: args.controllerSha256, artifactId: args.artifactId, source: args.source,
      bytes: new TextEncoder().encode(args.source).byteLength, createdAtMs: Date.now(),
    });
    return { duplicate: false };
  },
});

export const status = query({
  args: { serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireUiAccess(args.serviceToken);
    const rows = await ctx.db.query("bundles").collect();
    return rows.map((row) => ({ key: row.key, sha256: row.sha256, bytes: row.bytes, uploadedAtMs: row.uploadedAtMs }));
  },
});
