import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  fitFromAuthorizationHeader,
  normalizeForgeInstallationId,
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
  }: { audience?: string | string[]; issuer?: string; expiration?: number } = {},
): Promise<string> {
  let jwt = new SignJWT({
    app: {
      id: appId,
      installation: { id: "installation-1" },
      environment: { type: "DEVELOPMENT" },
    },
    context: {
      cloudId: "cloud-1",
      siteUrl: "https://example.atlassian.net",
      extension: {
        issue: { key: "FS-42" },
        project: { key: "FS" },
      },
    },
    principal: "fixture-principal",
    ...payload,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(audience)
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

  it("accepts both audience forms and installation claim locations", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const keySet = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }],
    });
    const verify = (token: string) => verifyForgeInvocationToken(token, { appId, keySet });
    const bareId = "12345678-1234-1234-1234-123456789abc";
    const bareAudience = await signedToken(privateKey, { app: { id: bareId, installationId: "installation-2", environment: { type: "PRODUCTION" } } }, { audience: bareId });
    const ariAudience = await signedToken(privateKey, { app: { id: appId, installationId: "installation-3", environment: { type: "STAGING" } } }, { audience: appId });
    const ariInstallation = await signedToken(privateKey, { app: { id: appId, installation: { id: "ari:cloud:ecosystem::installation/installation-4" }, environment: { type: "STAGING" } } }, { audience: appId });
    expect(await verify(bareAudience)).toMatchObject({ installationId: "installation-2", environmentType: "PRODUCTION" });
    expect(await verify(ariAudience)).toMatchObject({ installationId: "installation-3", environmentType: "STAGING" });
    expect(await verify(ariInstallation)).toMatchObject({ installationId: "installation-4" });
    expect(normalizeForgeInstallationId("ari:cloud:ecosystem::installation/installation-5")).toBe("installation-5");
  });

  it("rejects the wrong audience, issuer, expiry, app id, and absent installation", async () => {
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
    await expect(
      verify(await signedToken(privateKey, { app: { id: appId, environment: { type: "DEVELOPMENT" } } })),
    ).rejects.toThrow("installation or environment");
    const unsigned = btoa(JSON.stringify({ alg: "none" })).replace(/=/g, "");
    const payload = btoa(JSON.stringify({ iss: "forge/invocation-token", aud: appId })).replace(/=/g, "");
    await expect(verify(`${unsigned}.${payload}.`)).rejects.toThrow();
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
