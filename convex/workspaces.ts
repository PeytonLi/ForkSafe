import { ConvexError, v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server.js";
import { UnauthorizedError } from "./lib/auth.js";
import { isPublicInvestigation } from "./lib/webAccess.js";
import { canReadInvestigation, ensurePersonalWorkspace } from "./lib/workspaces.js";

function inviteCode(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 22);
}

async function callerUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new UnauthorizedError();
  const userId = ctx.db.normalizeId("users", identity.subject.split("|")[0] ?? "");
  const user = userId ? await ctx.db.get(userId) : null;
  if (!user) throw new UnauthorizedError();
  return user;
}

/** Creates the signed-in person's workspace the first time they open the app. */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await callerUser(ctx);
    const workspace = await ensurePersonalWorkspace(ctx, user);
    if (!workspace) throw new ConvexError("workspace_missing");
    return { id: workspace.appId, name: workspace.name };
  },
});

/** A lead mints a code that adds someone to their workspace only. */
export const createInvite = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await callerUser(ctx);
    const workspace = await ensurePersonalWorkspace(ctx, user);
    if (!workspace) throw new ConvexError("workspace_missing");
    const member = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspace.appId).eq("userId", user._id)).unique();
    if (!member || member.role !== "lead") throw new UnauthorizedError();
    const code = inviteCode();
    await ctx.db.insert("workspaceInvites", { code, workspaceId: workspace.appId, createdBy: user._id, createdAtMs: Date.now() });
    return { code, workspaceName: workspace.name };
  },
});

export async function acceptInvite(ctx: any, user: { _id: any }, code: string): Promise<boolean> {
  const invite = await ctx.db.query("workspaceInvites").withIndex("by_code", (q: any) => q.eq("code", code)).unique();
  if (!invite) return false;
  const existing = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", invite.workspaceId).eq("userId", user._id)).unique();
  if (!existing) {
    await ctx.db.insert("workspaceMembers", { workspaceId: invite.workspaceId, userId: user._id, role: "operator", createdAtMs: Date.now() });
  }
  return true;
}

export const canRead = internalQuery({
  args: { investigationId: v.string() },
  handler: async (ctx, args) => {
    if (isPublicInvestigation(args.investigationId)) return true;
    const row = await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.investigationId)).unique();
    if (!row) return false;
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const userId = ctx.db.normalizeId("users", identity.subject.split("|")[0] ?? "");
    const user = userId ? await ctx.db.get(userId) : null;
    return canReadInvestigation(ctx, row, user, userId);
  },
});
