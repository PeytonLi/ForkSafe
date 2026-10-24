import type { Auth } from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import { constantTimeEqual, isLocalDeployment, UnauthorizedError } from "./auth.js";

type Env = Record<string, string | undefined>;
type UserRow = { accessGranted?: boolean } | null;
type UserDb = {
  get: (id: Id<"users">) => Promise<UserRow>;
  normalizeId: (table: "users", id: string) => Id<"users"> | null;
};

/** New Google accounts store accessGranted: false until they redeem the invite.
 *  Older accounts omit the field and keep the access they already had. A missing
 *  user row is a legacy or test identity, not a pending Google account. */
export function accessGrantedForUser(user: UserRow): boolean {
  return user == null || user.accessGranted !== false;
}

export function newOAuthAccountNeedsInvite(type: string, existingUserId: string | null): boolean {
  return existingUserId === null && type === "oauth";
}

export async function identityHasAccess(ctx: { db: UserDb }, identity: { subject: string }): Promise<boolean> {
  const raw = identity.subject.split("|")[0] ?? "";
  const userId = ctx.db.normalizeId("users", raw);
  // Convex Auth subjects are `<users id>|<session id>`. Anything else is a
  // legacy or test identity and is not a Google account waiting on an invite.
  if (!userId) return true;
  return accessGrantedForUser(await ctx.db.get(userId));
}

export function validateInvite(params: Record<string, unknown>, env: Env = process.env): void {
  if (params.flow !== "signUp") return;
  const expected = env.FORKSAFE_INVITE_CODE;
  if (!expected || typeof params.inviteCode !== "string" || !constantTimeEqual(params.inviteCode, expected)) {
    throw new Error("Invalid invite code");
  }
}

export function isPublicInvestigation(id: string, env: Env = process.env): boolean {
  return (env.FORKSAFE_PUBLIC_INVESTIGATION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(id);
}

function validServiceToken(token: string | undefined, env: Env): boolean {
  return !!token && !!env.INTEGRATION_SHARED_SECRET && constantTimeEqual(token, env.INTEGRATION_SHARED_SECRET);
}

type ActCtx = { auth: Auth; db?: UserDb; runQuery?: (ref: unknown, args: Record<string, never>) => Promise<boolean> };

async function identityMayAct(ctx: ActCtx, identity: { subject: string }): Promise<boolean> {
  if (ctx.db) return identityHasAccess({ db: ctx.db }, identity);
  if (!ctx.runQuery) return false;
  const { internal } = await import("../_generated/api.js");
  return ctx.runQuery(internal.auth.sessionAccess, {});
}

export async function hasPrivateAccess(ctx: { auth: Auth; db: UserDb }, token?: string, env: Env = process.env): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) return identityHasAccess(ctx, identity);
  return validServiceToken(token, env);
}

export async function requireInvestigationRead(ctx: { auth: Auth; db: UserDb }, id: string, token?: string): Promise<void> {
  if (!isPublicInvestigation(id) && !await hasPrivateAccess(ctx, token)) throw new UnauthorizedError();
}

export async function requireWriteIdentity(ctx: { auth: Auth }, token?: string, env: Env = process.env): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    if (!await identityMayAct(ctx as ActCtx, identity)) throw new UnauthorizedError();
    return `convex-auth:${identity.subject}`;
  }
  if (validServiceToken(token, env)) return "service:integration";
  if (isLocalDeployment(env) && env.FORKSAFE_DEV_ANONYMOUS_UI === "true") return "local:anonymous-ui";
  throw new UnauthorizedError();
}
