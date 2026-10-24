import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  fitFromAuthorizationHeader,
  verifyForgeInvocationToken,
} from "../src/fit.js";

const appId = "ari:cloud:ecosystem::app/12345678-1234-1234-1234-123456789abc";

async function signedToken(
  privateKey: CryptoKey,
  payload: Record<string, unknown> = {},
  {
    audience = appId,
    issuer = "forge/invocation-token",
    expiration,
  }: { audience?: string; issuer?: string; expiration?: number } = {},
): Promise<string> {
  let jwt = new SignJWT({
    app: { id: appId },
    installation: { id: "installation-1" },
    environment: { type: "DEVELOPMENT" },
    context: {
      cloudId: "cloud-1",
      siteUrl: "https://example.atlassian.net",
      extension: {
        issue: { key: "FS-42" },
        project: { key: "FS" },
      },
    },
    ...payload,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("fixture-principal")
    .setIssuedAt();
  jwt = expiration
    ? jwt.setExpirationTime(expiration)
    : jwt.setExpirationTime("2 minutes");
  return jwt.sign(privateKey);
}

describe("Forge Invocation Token verification", () => {
  it("verifies signature and maps app, installation, environment, and issue claims", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const keySet = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }],
    });
    const result = await verifyForgeInvocationToken(
      await signedToken(privateKey),
      { appId, keySet },
    );
    expect(result).toEqual({
      appId,
      installationId: "installation-1",
      environmentType: "DEVELOPMENT",
      principal: "fixture-principal",
      cloudId: "cloud-1",
      siteUrl: "https://example.atlassian.net",
      issueKey: "FS-42",
      projectKey: "FS",
    });
  });

  it("rejects the wrong audience, issuer, expiry, and app id", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const keySet = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }],
    });
    const verify = (token: string) => verifyForgeInvocationToken(token, { appId, keySet });
    await expect(
      verify(await signedToken(privateKey, {}, { audience: "wrong-app" })),
    ).rejects.toThrow();
    await expect(
      verify(await signedToken(privateKey, {}, { issuer: "wrong-issuer" })),
    ).rejects.toThrow();
    await expect(
      verify(await signedToken(privateKey, {}, { expiration: Math.floor(Date.now() / 1000) - 5 })),
    ).rejects.toThrow();
    await expect(
      verify(await signedToken(privateKey, { app: { id: "other-app" } })),
    ).rejects.toThrow("app.id");
  });

  it("validates installation-context labels and authorization headers", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const keySet = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }],
    });
    await expect(
      verifyForgeInvocationToken(
        await signedToken(privateKey, { icLabel: "INVALID LABEL" }),
        { appId, keySet },
      ),
    ).rejects.toThrow("invalid icLabel");
    await expect(
      verifyForgeInvocationToken(
        await signedToken(privateKey, { icLabel: "valid-ic" }),
        { appId },
      ),
    ).rejects.toThrow("inject its trusted key set");
    expect(fitFromAuthorizationHeader("Bearer signed-token")).toBe("signed-token");
    expect(() => fitFromAuthorizationHeader("Basic abc")).toThrow("Bearer");
  });
});
