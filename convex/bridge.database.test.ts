import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./bridge.js";
import { internal } from "./_generated/api.js";
import { SpacetimeConfigError } from "./lib/spacetime.js";
import schema from "./schema.js";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("./**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\//, ""), load]),
);

describe("BridgeClient HTTP base", () => {
  it.each([
    { uri: "wss://spacetime.example.invalid/", httpBase: "https://spacetime.example.invalid" },
    { uri: "ws://spacetime.example.invalid/", httpBase: "http://spacetime.example.invalid" },
  ])("uses the shared normalized base for $uri", async ({ uri, httpBase }) => {
    const urls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const client = new BridgeClient({
        runQuery: async () => ({ token: "bridge-token", identity: "bridge-identity" }),
        runMutation: async () => undefined,
      }, {
        SPACETIMEDB_MODE: "cloud",
        SPACETIMEDB_URI: uri,
        SPACETIMEDB_DATABASE: "bridge-test",
        FORKSAFE_BRIDGE_SECRET: "bridge-secret",
      });

      await expect(client.sql("SELECT 1")).resolves.toEqual([]);
      expect(urls).toEqual([`${httpBase}/v1/database/bridge-test/sql`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects unsupported URI schemes with a typed configuration error", () => {
    expect(() => new BridgeClient({ runQuery: async () => ({}), runMutation: async () => undefined }, {
      SPACETIMEDB_MODE: "cloud",
      SPACETIMEDB_URI: "ftp://spacetime.example.invalid",
      SPACETIMEDB_DATABASE: "bridge-test",
      FORKSAFE_BRIDGE_SECRET: "bridge-secret",
    })).toThrow(SpacetimeConfigError);
  });
});

describe("bridge reset mutation", () => {
  it("clears stored credentials and returns no token material", async () => {
    const t = convexTest(schema, modules);
    const flagId = await t.run((ctx) => ctx.db.insert("systemFlags", {
      key: "global",
      admissionPaused: false,
      bridgeToken: "sensitive-bridge-token",
      bridgeIdentity: "sensitive-bridge-identity",
      bridgeRegisteredAtMs: 123,
      bridgeLastHealthyAtMs: 456,
    }));

    const result = await t.mutation(internal.bridge.resetBridgeState, {});

    expect(result).toEqual({ reset: true });
    expect(JSON.stringify(result)).not.toContain("sensitive-bridge");
    const flag = await t.run((ctx) => ctx.db.get(flagId));
    expect(flag).not.toHaveProperty("bridgeToken");
    expect(flag).not.toHaveProperty("bridgeIdentity");
    expect(flag).not.toHaveProperty("bridgeRegisteredAtMs");
    expect(flag).not.toHaveProperty("bridgeLastHealthyAtMs");
    expect(flag?.bridgeLastError).toBe("bridge_state_reset");
  });

  it("returns false when the global systemFlags row is missing", async () => {
    const t = convexTest(schema, modules);

    await expect(t.mutation(internal.bridge.resetBridgeState, {})).resolves.toEqual({ reset: false });
  });
});
