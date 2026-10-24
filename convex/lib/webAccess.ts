import type { Auth } from "convex/server";
import { constantTimeEqual, UnauthorizedError } from "./auth.js";

type Env = Record<string, string | undefined>;

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

export async function hasPrivateAccess(ctx: { auth: Auth }, token?: string, env: Env = process.env): Promise<boolean> {
  return !!await ctx.auth.getUserIdentity() || validServiceToken(token, env);
}

export async function requireInvestigationRead(ctx: { auth: Auth }, id: string, token?: string): Promise<void> {
  if (!isPublicInvestigation(id) && !await hasPrivateAccess(ctx, token)) throw new UnauthorizedError();
}

export async function requireWriteIdentity(ctx: { auth: Auth }, token?: string, env: Env = process.env): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) return `convex-auth:${identity.subject}`;
  if (validServiceToken(token, env)) return "service:integration";
  let local = false;
  try { local = ["127.0.0.1", "localhost"].includes(new URL(env.CONVEX_CLOUD_URL ?? "").hostname); } catch { /* fail closed */ }
  if (local && env.FORKSAFE_DEV_ANONYMOUS_UI === "true") return "local:anonymous-ui";
  throw new UnauthorizedError();
}
