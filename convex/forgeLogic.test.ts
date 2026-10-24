import { describe, expect, it } from "vitest";
import {
  authenticateForgeRequest,
  authorizeForgeContext,
  authorizeReviewIdentity,
} from "./forgeLogic.js";
import type { ForgeInvocationContext } from "../packages/integrations/atlassian/src/index.js";

const context: ForgeInvocationContext = {
  appId: "app-1",
  installationId: "ari:cloud:ecosystem::installation/3c0775f6-4d23-4a64-b3bb-d32c0f084a66",
  environmentType: "DEVELOPMENT",
  principal: "account-1",
  issueKey: "FS-42",
  projectKey: "FS",
};
const environment = {
  FORGE_ALLOWED_INSTALLATION_IDS: "3c0775f6-4d23-4a64-b3bb-d32c0f084a66",
  ATLASSIAN_PROJECT_KEY: "FS",
};
const verify = async (token: string) => {
  if (token !== "valid") throw new Error("invalid token");
  return context;
};

describe("Forge route authorization logic", () => {
  it.each(["panel", "investigations", "review-context", "reviews"])(
    "fails closed for %s authentication failures",
    async () => {
      expect(await authenticateForgeRequest(undefined, environment, verify)).toEqual({
        ok: false,
        status: 401,
        error: "unauthorized",
      });
      expect(await authenticateForgeRequest("Bearer garbage", environment, verify)).toEqual({
        ok: false,
        status: 401,
        error: "unauthorized",
      });
      expect(await authenticateForgeRequest("Bearer valid", {
        ...environment,
        FORGE_ALLOWED_INSTALLATION_IDS: "another-installation",
      }, verify)).toEqual({ ok: false, status: 403, error: "forbidden" });
      expect(await authenticateForgeRequest("Bearer valid", {
        ATLASSIAN_PROJECT_KEY: "FS",
      }, verify)).toEqual({ ok: false, status: 503, error: "forge_not_configured" });
    },
  );

  it("accepts allow-listed bare/ARI installation ids but rejects project and issue drift", async () => {
    expect(await authenticateForgeRequest("Bearer valid", {
      ...environment,
      FORGE_ALLOWED_INSTALLATION_IDS: "ari:cloud:ecosystem::installation/3c0775f6-4d23-4a64-b3bb-d32c0f084a66",
    }, verify)).toMatchObject({ ok: true });
    expect(authorizeForgeContext(context, {
      issueKey: "FS-43",
      projectKey: "FS",
    }, "FS")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(authorizeForgeContext(context, {
      issueKey: "FS-42",
      projectKey: "OTHER",
    }, "FS")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(authorizeForgeContext(context, {
      issueKey: "FS-42",
      projectKey: "FS",
    }, "FS")).toEqual({ ok: true });
  });

  it("derives review identity only from the token principal", () => {
    expect(authorizeReviewIdentity(context, { reviewerIdentity: "atlassian:account-1" })).toEqual({
      ok: true,
      reviewerIdentity: "atlassian:account-1",
    });
    expect(authorizeReviewIdentity(context, { reviewerIdentity: "atlassian:attacker" })).toEqual({
      ok: false,
      status: 403,
      error: "forbidden",
    });
    const { principal: _principal, ...withoutPrincipal } = context;
    expect(authorizeReviewIdentity(withoutPrincipal, { reviewerIdentity: "atlassian:account-1" })).toEqual({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
  });
});
