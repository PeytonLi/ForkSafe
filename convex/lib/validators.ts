import { ConvexError } from "convex/values";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUUID(value: string, field = "appId"): void {
  if (!UUID_RE.test(value)) throw new ConvexError(`${field}_must_be_uuid`);
}

export function appId(): string {
  return crypto.randomUUID();
}
