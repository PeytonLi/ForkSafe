import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = Object.fromEntries(
  Object.entries((import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> })
    .glob("./**/*.ts"))
    .map(([path, load]) => [path.replace(/^\.\//, ""), load]),
);

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
