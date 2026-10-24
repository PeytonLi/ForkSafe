import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { query } from "./_generated/server.js";
import { validateInvite } from "./lib/webAccess.js";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password({
    profile(params) {
      validateInvite(params);
      if (typeof params.email !== "string" || !params.email.trim()) throw new Error("Email required");
      return { email: params.email.trim().toLowerCase() };
    },
  })],
});

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return identity ? { subject: identity.subject } : null;
  },
});
