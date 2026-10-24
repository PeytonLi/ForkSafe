export function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export function isLocalDeployment(env: Record<string, string | undefined> = process.env): boolean {
  try { return ["localhost", "127.0.0.1"].includes(new URL(env.CONVEX_CLOUD_URL ?? "").hostname); }
  catch { return false; }
}

export function requireServiceToken(
  token: string | undefined,
  envSecret = process.env.INTEGRATION_SHARED_SECRET,
): void {
  if (!envSecret || !token || !constantTimeEqual(token, envSecret)) {
    throw new UnauthorizedError();
  }
}

export function requireUiAccess(
  token: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.INTEGRATION_SHARED_SECRET && token && constantTimeEqual(token, env.INTEGRATION_SHARED_SECRET)) return;
  if (env.FORKSAFE_DEV_ANONYMOUS_UI === "true" && isLocalDeployment(env)) return;
  throw new UnauthorizedError();
}
