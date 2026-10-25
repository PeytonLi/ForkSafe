import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexReactClient } from "convex/react";
import { describeScene } from "@forksafe/contracts";
import { FixtureClient } from "./fixtureClient";
import { CONVEX_RESPONSE_SCHEMAS, ConvexForkSafeClient } from "./convexClient";

afterEach(() => vi.restoreAllMocks());

describe("scene description clients", () => {
  it("fixture mode uses only deterministic sample data, without fetching", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const client = new FixtureClient({ latencyMs: 0, storage: null });
    const text = "push through a narrow gap faster";
    expect(await client.describeScene(text)).toEqual({ ...describeScene(text), mode: "fixture" });
    expect(await client.describeScene("a drone landing")).toMatchObject({ mode: "fixture", status: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("live client preserves rules/LLM provenance from the action", async () => {
    const action = vi.spyOn(ConvexReactClient.prototype, "action");
    const client = new ConvexForkSafeClient("https://example.convex.cloud");
    try {
      for (const mode of ["rules", "llm"] as const) {
        const result = { ...describeScene("push through a gap"), mode, fallback: mode === "rules" };
        action.mockResolvedValueOnce(result);
        expect(await client.describeScene("push through a gap")).toEqual(result);
        expect(action).toHaveBeenLastCalledWith(expect.anything(), { text: "push through a gap" });
      }
    } finally { await client.react.close(); }
  });

  it("rejects malformed or mislabeled live responses instead of inventing settings", () => {
    const parse = (value: unknown) => CONVEX_RESPONSE_SCHEMAS.describeScene.safeParse(value).success;
    const result = { mode: "llm", status: "matched", taskFamily: "push_through_gap", overrides: {}, explanation: "Matched" };
    expect(parse(result)).toBe(true);
    expect(parse({ ...result, mode: "fixture" })).toBe(false);
    expect(parse({ ...result, taskFamily: "drone" })).toBe(false);
    expect(parse({ ...result, overrides: { dividerHeight: 0.1 } })).toBe(false);
    expect(parse({ ...result, overrides: { gapWidth: 2 } })).toBe(false);
    expect(parse({ ...result, overrides: { gapWidth: "0.1" } })).toBe(false);
    expect(parse({ ...result, overrides: { speedScale: Infinity } })).toBe(false);
  });
});
