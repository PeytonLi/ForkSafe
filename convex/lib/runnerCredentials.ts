import { RUNNER_CREDENTIAL_TTL_MS } from "./constants.js";
import { randomSecret } from "./runnerAuth.js";
import { appId, assertUUID } from "./validators.js";

export async function issueRunnerCredential(
  ctx: any,
  args: { investigationId: string; environmentId: string; sandboxOpId?: string },
) {
  assertUUID(args.investigationId, "investigationId");
  assertUUID(args.environmentId, "environmentId");
  const now = Date.now();
  const previous = await ctx.db.query("runnerCredentials")
    .withIndex("by_environment", (q: any) => q.eq("environmentId", args.environmentId))
    .collect();
  for (const row of previous) {
    if (row.revokedAtMs === undefined) await ctx.db.patch(row._id, { revokedAtMs: now, revokeReason: "superseded" });
  }
  const credentialId = appId();
  const secret = randomSecret();
  const expiresAtMs = now + RUNNER_CREDENTIAL_TTL_MS;
  await ctx.db.insert("runnerCredentials", {
    appId: credentialId,
    investigationId: args.investigationId,
    environmentId: args.environmentId,
    ...(args.sandboxOpId ? { sandboxOpId: args.sandboxOpId } : {}),
    secret,
    expiresAtMs,
    createdAtMs: now,
  });
  const environment = await ctx.db.query("environments")
    .withIndex("by_appId", (q: any) => q.eq("appId", args.environmentId))
    .unique();
  if (environment) await ctx.db.patch(environment._id, { runnerCredentialId: credentialId });
  return { credentialId, secret, expiresAtMs };
}
