import { describe, expect, it } from "vitest";
import {
  atlassianReadiness,
  createAtlassianClients,
} from "../src/config.js";
import { AtlassianBlockedError } from "../src/config.js";

const complete = {
  ATLASSIAN_MODE: "cloud",
  ATLASSIAN_SITE_URL: "https://example.atlassian.net",
  ATLASSIAN_EMAIL: "reviewer@example.test",
  ATLASSIAN_API_TOKEN: "secret-token-for-test",
  ATLASSIAN_PROJECT_KEY: "FS",
};

describe("Atlassian configuration", () => {
  it("selects fixture mode and returns honest fixture readiness", () => {
    const clients = createAtlassianClients({ ATLASSIAN_MODE: "fixture" });
    expect(clients.mode).toBe("fixture");
    expect(clients.readiness.map((item) => item.mode)).toEqual(["fixture", "fixture"]);
  });

  it("blocks cloud mode with missing variable names but no values", async () => {
    const env = {
      ATLASSIAN_MODE: "cloud",
      ATLASSIAN_EMAIL: "secret@example.test",
    };
    const clients = createAtlassianClients(env);
    expect(clients.mode).toBe("blocked");
    expect(clients.readiness[0]?.detail).toContain("ATLASSIAN_SITE_URL");
    expect(clients.readiness[0]?.detail).not.toContain("secret@example.test");
    await expect(clients.jira.probe()).rejects.toBeInstanceOf(AtlassianBlockedError);
    expect(atlassianReadiness(env, 123).map((item) => item.checkedAtMs)).toEqual([
      123,
      123,
    ]);
  });

  it("uses Basic auth when cloud settings are complete", async () => {
    let authorization = "";
    const clients = createAtlassianClients(complete, {
      fetch: (async (_input, init) => {
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(clients.mode).toBe("live");
    await clients.jira.probe();
    expect(authorization).toBe(
      `Basic ${btoa("reviewer@example.test:secret-token-for-test")}`,
    );
  });
});
