import Auth0 from "./node_modules/@auth/core/providers/auth0.js";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { UnauthorizedError } from "./lib/auth.js";
import { roleOf } from "./lib/memberRole.js";
import { accessGrantedForUser, identityHasAccess, newOAuthAccountNeedsInvite, validateInvite } from "./lib/webAccess.js";
import { workspaceForUser } from "./lib/workspaces.js";
import { acceptInvite } from "./workspaces.js";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Auth0({
      // Auth0 owns the Google connection, including its developer keys.
      // `connection` skips the Auth0 account picker and opens Google directly.
      authorization: { params: { connection: "google-oauth2", scope: "openid email profile", prompt: "select_account" } },
      profile(profile) {
        if (!profile.email_verified || !profile.email) throw new Error("Google email is not verified");
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email.toLowerCase(),
          image: profile.picture,
          emailVerified: true,
        };
      },
    }),
    Password({
      profile(params) {
        validateInvite(params);
        if (typeof params.email !== "string" || !params.email.trim()) throw new Error("Email required");
        return { email: params.email.trim().toLowerCase() };
      },
    }),
  ],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, args) {
      if (!newOAuthAccountNeedsInvite(args.type, args.existingUserId)) return;
      await ctx.db.patch(args.userId, { accessGranted: false });
    },
  },
});

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = ctx.db.normalizeId("users", identity.subject.split("|")[0] ?? "");
    const user = userId ? await ctx.db.get(userId) : null;
    const workspace = user ? await workspaceForUser(ctx, user._id) : null;
    return {
      subject: identity.subject,
      email: user?.email ?? null,
      accessGranted: accessGrantedForUser(user),
      memberRole: roleOf(user),
      workspace: workspace ? { id: workspace.appId, name: workspace.name } : null,
    };
  },
});

const memberRoleArg = v.union(v.literal("lead"), v.literal("operator"), v.literal("reviewer"));

/** A lead with access assigns seats to someone else. You cannot change your own seat. */
export const setMemberRole = mutation({
  args: { role: memberRoleArg, email: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new UnauthorizedError();
    const userId = ctx.db.normalizeId("users", identity.subject.split("|")[0] ?? "");
    const caller = userId ? await ctx.db.get(userId) : null;
    if (!caller || !accessGrantedForUser(caller) || roleOf(caller) !== "lead") throw new UnauthorizedError();
    const requested = args.email?.trim().toLowerCase() ?? "";
    if (!requested) throw new ConvexError("Pick whose seat to change.");
    const own = caller.email?.trim().toLowerCase() ?? "";
    if (requested === own) throw new ConvexError("You cannot change your own seat.");
    const target = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", requested)).unique();
    if (!target) throw new ConvexError("No account with that email");
    if (roleOf(target) === "lead" && args.role !== "lead") {
      const users = await ctx.db.query("users").collect();
      const leads = users.filter((user) => user.accessGranted === true && roleOf(user) === "lead").length;
      if (leads <= 1) throw new ConvexError("The last lead cannot leave that seat.");
    }
    await ctx.db.patch(target._id, { memberRole: args.role });
    return { memberRole: args.role };
  },
});

/** Ops: restore a seat from the Convex CLI when someone demoted the only active lead. */
export const forceMemberRole = internalMutation({
  args: { email: v.string(), role: memberRoleArg },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const target = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).unique();
    if (!target) throw new ConvexError("No account with that email");
    await ctx.db.patch(target._id, { memberRole: args.role });
    return { memberRole: args.role, email };
  },
});

const MAX_INVITE_GUESSES = 8;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

/** Browser sessions call this after Google sign-in. Password sign-up still checks the invite in the provider.
 *  A wrong code returns { ok: false } so the failure count is committed; throwing would roll it back. */
export const redeemInvite = mutation({
  args: { inviteCode: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new UnauthorizedError();
    const userId = ctx.db.normalizeId("users", identity.subject.split("|")[0] ?? "");
    const user = userId ? await ctx.db.get(userId) : null;
    if (!user) throw new UnauthorizedError();
    const now = Date.now();
    const inWindow = user.inviteFailureWindowStartMs !== undefined && now - user.inviteFailureWindowStartMs < INVITE_WINDOW_MS;
    const failures = inWindow ? (user.inviteFailures ?? 0) : 0;
    if (failures >= MAX_INVITE_GUESSES) return { ok: false as const };
    if (await acceptInvite(ctx, user, args.inviteCode)) {
      await ctx.db.patch(user._id, { inviteFailures: 0 });
      return { ok: true as const };
    }
    let accepted = false;
    try {
      validateInvite({ flow: "signUp", inviteCode: args.inviteCode });
      accepted = true;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      await ctx.db.patch(user._id, { inviteFailures: failures + 1, inviteFailureWindowStartMs: inWindow ? user.inviteFailureWindowStartMs : now });
      return { ok: false as const };
    }
    await ctx.db.patch(user._id, { accessGranted: true, inviteFailures: 0 });
    return { ok: true as const };
  },
});

export const sessionAccess = internalQuery({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    return identityHasAccess(ctx, identity);
  },
});
