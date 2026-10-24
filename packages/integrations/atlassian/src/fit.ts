import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

const DEFAULT_JWKS_URL =
  "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json";

export type ForgeInvocationContext = {
  appId: string;
  installationId: string;
  environmentType: string;
  principal?: string;
  cloudId?: string;
  siteUrl?: string;
  issueKey?: string;
  projectKey?: string;
};

export async function verifyForgeInvocationToken(
  token: string,
  {
    appId,
    keySet,
    jwksUrl = DEFAULT_JWKS_URL,
  }: {
    appId: string;
    keySet?: JWTVerifyGetKey;
    jwksUrl?: string;
  },
): Promise<ForgeInvocationContext> {
  const unverified = decodePayload(token);
  const unverifiedContext = record(unverified.context);
  const icLabel = stringValue(unverified.icLabel) ?? stringValue(unverifiedContext.icLabel);
  if (icLabel !== undefined && !/^[a-z0-9_-]{1,50}$/.test(icLabel)) {
    throw new Error("Forge invocation token contains an invalid icLabel.");
  }
  if (icLabel !== undefined && keySet === undefined) {
    throw new Error(
      `Forge invocation token uses IC label "${icLabel}"; inject its trusted key set to verify it.`,
    );
  }
  const verifier = keySet ?? createRemoteJWKSet(new URL(jwksUrl));
  const { payload } = await jwtVerify(token, verifier, {
    audience: appId,
    issuer: "forge/invocation-token",
  });
  const claims = payload as JWTPayload & Record<string, unknown>;
  const app = record(claims.app);
  if (app.id !== appId) {
    throw new Error("Forge invocation token app.id does not match the configured app.");
  }
  const installation = record(claims.installation);
  const environment = record(claims.environment);
  const context = record(claims.context);
  const extension = record(context.extension);
  const issue = record(extension.issue);
  const project = record(extension.project);
  const installationId =
    stringValue(claims.installationId) ??
    stringValue(installation.id) ??
    stringValue(context.installationId);
  const environmentType =
    stringValue(claims.environmentType) ??
    stringValue(environment.type) ??
    stringValue(context.environmentType);
  if (!installationId || !environmentType) {
    throw new Error("Forge invocation token is missing installation or environment claims.");
  }
  return {
    appId,
    installationId,
    environmentType,
    ...(stringValue(claims.sub) ? { principal: stringValue(claims.sub) } : {}),
    ...(stringValue(context.cloudId) ? { cloudId: stringValue(context.cloudId) } : {}),
    ...(stringValue(context.siteUrl) ? { siteUrl: stringValue(context.siteUrl) } : {}),
    ...(stringValue(issue.key) ? { issueKey: stringValue(issue.key) } : {}),
    ...(stringValue(project.key) ? { projectKey: stringValue(project.key) } : {}),
  };
}

export function fitFromAuthorizationHeader(
  authorization: string | undefined,
): string {
  if (!authorization) throw new Error("Missing Forge invocation authorization.");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new Error("Expected a Bearer Forge invocation token.");
  return match[1];
}

function decodePayload(token: string): Record<string, unknown> {
  const encoded = token.split(".")[1];
  if (!encoded) throw new Error("Malformed Forge invocation token.");
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new Error("Malformed Forge invocation token payload.");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
