import Auth0 from "@auth/core/providers/auth0";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server.js";
import { UnauthorizedError } from "./lib/auth.js";
import { accessGrantedForUser, identityHasAccess, newOAuthAccountNeedsInvite, validateInvite } from "./lib/webAccess.js";

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
    return {
      subject: identity.subject,
      email: user?.email ?? null,
      accessGranted: accessGrantedForUser(user),
    };
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
