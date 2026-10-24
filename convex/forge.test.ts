import { afterEach, describe, expect, it, vi } from "vitest";
import { FORGE_BACKEND_PATHS } from "../packages/integrations/atlassian/src/index.js";
import type { HttpRouter } from "convex/server";
import { registerForgeRoutes } from "./forge.js";
import { FORGE_FEATURE_PATHS } from "./forgeProtocolExt.js";

const paths = [...Object.values(FORGE_BACKEND_PATHS), ...Object.values(FORGE_FEATURE_PATHS)];

describe("Forge HTTP routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("registers the five backend paths as POST routes", () => {
    const routes: Array<{ path: string; method: string }> = [];
    const router = {
      route: (route: { path: string; method: string }) => routes.push(route),
    } as unknown as HttpRouter;

    registerForgeRoutes(router);

    expect(routes.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: FORGE_BACKEND_PATHS.panel, method: "POST" },
      { path: FORGE_BACKEND_PATHS.start, method: "POST" },
      { path: FORGE_BACKEND_PATHS.reviewContext, method: "POST" },
      { path: FORGE_BACKEND_PATHS.review, method: "POST" },
      { path: FORGE_FEATURE_PATHS.requests, method: "POST" },
    ]);
  });

  it("returns generic 401s for missing, malformed, and wrong-app tokens on every route", async () => {
    vi.stubEnv("FORGE_ALLOWED_INSTALLATION_IDS", "install-good");
    vi.stubEnv("ATLASSIAN_PROJECT_KEY", "FS");
    const handlers = createHandlers();

    for (const path of paths) {
      for (const authorization of [undefined, "Bearer garbage", "Bearer wrong-app"]) {
        const response = await handlers.get(path)!({} as never, request(path, authorization));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthorized" });
      }
    }
  });

  it("fails closed on unknown installations and project drift for every route", async () => {
    vi.stubEnv("FORGE_ALLOWED_INSTALLATION_IDS", "install-good");
    vi.stubEnv("ATLASSIAN_PROJECT_KEY", "FS");
    const handlers = createHandlers();

    for (const path of paths) {
      const unknown = await handlers.get(path)!({} as never, request(path, "Bearer unknown-install"));
      expect(unknown.status).toBe(403);

      const mismatchedProject = await handlers.get(path)!(
        {} as never,
        request(path, "Bearer wrong-project", bodyFor(path, "OTHER")),
      );
      expect(mismatchedProject.status).toBe(403);
    }
  });

  it("rejects a reviewer identity not derived from the FIT principal", async () => {
    vi.stubEnv("FORGE_ALLOWED_INSTALLATION_IDS", "install-good");
    vi.stubEnv("ATLASSIAN_PROJECT_KEY", "FS");
    const handlers = createHandlers();
    const response = await handlers.get(FORGE_BACKEND_PATHS.review)!(
      {} as never,
      request(FORGE_BACKEND_PATHS.review, "Bearer valid", {
        review: {
          id: "11111111-1111-4111-8111-111111111111",
          investigationId: "22222222-2222-4222-8222-222222222222",
          candidateId: "33333333-3333-4333-8333-333333333333",
          evaluationId: "44444444-4444-4444-8444-444444444444",
          controllerSha256: "a".repeat(64),
          decision: "approved",
          reviewerIdentity: "atlassian:attacker",
          createdAtMs: 1,
        },
      }),
    );
    expect(response.status).toBe(403);
  });
});

function createHandlers() {
  const handlers = new Map<string, (ctx: never, request: Request) => Promise<Response>>();
  const router = {
    route: (route: { path: string; handler: (ctx: never, request: Request) => Promise<Response> }) => {
      handlers.set(route.path, route.handler);
    },
  } as unknown as HttpRouter;
  registerForgeRoutes(router, {
    verifyToken: async (token) => {
      if (!["valid", "unknown-install", "wrong-project"].includes(token)) throw new Error("invalid");
      return {
        appId: "app-1",
        installationId: token === "unknown-install" ? "install-unknown" : "install-good",
        environmentType: "DEVELOPMENT",
        principal: "reviewer-1",
        issueKey: "FS-42",
        projectKey: token === "wrong-project" ? "OTHER" : "FS",
      };
    },
  });
  return handlers;
}

function request(path: string, authorization?: string, body = bodyFor(path, "FS")) {
  return new Request(`https://convex.example.invalid${path}`, {
    method: "POST",
    ...(authorization ? { headers: { authorization } } : {}),
    body: JSON.stringify(body),
  });
}

function bodyFor(path: string, projectKey: string) {
  if (path === FORGE_FEATURE_PATHS.requests) {
    return { investigationId: "11111111-1111-4111-8111-111111111111", issueKey: "FS-42", projectKey,
      requestedBy: "atlassian:reviewer-1", note: "Try another approach", extraEnvironments: 1, idempotencyKey: "55555555-5555-4555-8555-555555555555" };
  }
  if (path === FORGE_BACKEND_PATHS.panel) {
    return { issueKey: "FS-42", issueId: "100", projectKey };
  }
  if (path === FORGE_BACKEND_PATHS.start) {
    return { issueKey: "FS-42", issueId: "100", projectKey, title: "Test investigation" };
  }
  if (path === FORGE_BACKEND_PATHS.reviewContext) {
    return {
      investigationId: "11111111-1111-4111-8111-111111111111",
      candidateId: "22222222-2222-4222-8222-222222222222",
      evaluationId: "33333333-3333-4333-8333-333333333333",
    };
  }
  return {
    review: {
      id: "44444444-4444-4444-8444-444444444444",
      investigationId: "11111111-1111-4111-8111-111111111111",
      candidateId: "22222222-2222-4222-8222-222222222222",
      evaluationId: "33333333-3333-4333-8333-333333333333",
      controllerSha256: "a".repeat(64),
      decision: "approved",
      reviewerIdentity: "atlassian:reviewer-1",
      createdAtMs: 1,
    },
  };
}
