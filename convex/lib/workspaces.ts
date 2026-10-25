import type { Id } from "../_generated/dataModel.js";
import { appId } from "./validators.js";

function granted(user: { accessGranted?: boolean } | null): boolean {
  return user == null || user.accessGranted !== false;
}

type UserDoc = { _id: Id<"users">; email?: string; accessGranted?: boolean } | null;

/** One workspace per person. Investigations without one stay in the original shared workspace. */
export function workspaceName(email: string | undefined): string {
  const local = email?.split("@")[0]?.replace(/[^\w.-]/g, "").slice(0, 40);
  return local ? `${local}'s workspace` : "My workspace";
}

export async function memberships(ctx: any, userId: Id<"users">) {
  return await ctx.db.query("workspaceMembers").withIndex("by_user", (q: any) => q.eq("userId", userId)).collect();
}

export async function ensurePersonalWorkspace(ctx: any, user: NonNullable<UserDoc>) {
  const existing = await ctx.db.query("workspaceMembers").withIndex("by_user", (q: any) => q.eq("userId", user._id)).first();
  if (existing) {
    return await ctx.db.query("workspaces").withIndex("by_appId", (q: any) => q.eq("appId", existing.workspaceId)).unique();
  }
  const now = Date.now();
  const id = appId();
  await ctx.db.insert("workspaces", { appId: id, name: workspaceName(user.email), createdAtMs: now });
  await ctx.db.insert("workspaceMembers", { workspaceId: id, userId: user._id, role: "lead", createdAtMs: now });
  return await ctx.db.query("workspaces").withIndex("by_appId", (q: any) => q.eq("appId", id)).unique();
}

export async function workspaceIdForCaller(ctx: any): Promise<string | undefined> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return undefined;
  const userId = ctx.db.normalizeId("users", identity.subject.split("|")[0] ?? "");
  const user = userId ? await ctx.db.get(userId) : null;
  if (!user) return undefined;
  const workspace = await ensurePersonalWorkspace(ctx, user);
  return workspace?.appId;
}

export async function workspaceForUser(ctx: any, userId: Id<"users">) {
  const member = await ctx.db.query("workspaceMembers").withIndex("by_user", (q: any) => q.eq("userId", userId)).first();
  if (!member) return null;
  return await ctx.db.query("workspaces").withIndex("by_appId", (q: any) => q.eq("appId", member.workspaceId)).unique();
}

export async function canReadInvestigation(ctx: any, row: { appId: string; workspaceId?: string }, user: UserDoc, userId: Id<"users"> | null): Promise<boolean> {
  if (!userId || !user) return true;
  if (!row.workspaceId) return granted(user);
  const member = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", row.workspaceId).eq("userId", userId)).unique();
  return !!member;
}
