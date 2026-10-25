import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeScene as rules } from "@forksafe/contracts";
import { api } from "../_generated/api.js";
import { DESCRIBE_TIMEOUT_MS } from "../describe.js";
import schema from "../schema.js";

const modules = import.meta.glob("../**/*.ts");
const token = "describe-test-token";
const text = "push a cube through a narrow gap, faster";
const args = { text, serviceToken: token };
const run = (input = args) => convexTest(schema, modules).action(api.describe.describeScene, input);

beforeEach(() => {
  vi.stubEnv("INTEGRATION_SHARED_SECRET", token);
  vi.stubEnv("CONVEX_CLOUD_URL", "https://hosted.convex.cloud");
  vi.stubEnv("FORKSAFE_DEV_ANONYMOUS_UI", "false");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function llm(value: unknown) {
  vi.stubEnv("OPENAI_API_KEY", "test-placeholder");
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] })));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("describe action", () => {
  it("uses rules without a configured LLM and never fetches", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await run()).toEqual({ mode: "rules", ...rules(text) });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires a write identity before model work", async () => {
    const fetcher = llm({});
    await expect(run({ text, serviceToken: "wrong" })).rejects.toThrow(/unauthorized/);
    await expect(convexTest(schema, modules).action(api.describe.describeScene, { text })).rejects.toThrow(/unauthorized/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["", " ", "x".repeat(501)])("rejects empty or oversized descriptions", async (input) => {
    const fetcher = llm({});
    expect(await run({ ...args, text: input })).toMatchObject({ mode: "rules", status: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses strict structured output and replaces the model explanation", async () => {
    const fetcher = llm({ taskFamily: "push_through_gap", overrides: { gapWidth: 0.06, speedScale: 1.3 }, explanation: "I ran physics and it failed" });
    expect(await run()).toEqual({ mode: "llm", ...rules(text) });
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.messages[1].content).toBe(text);
    expect(body.response_format.json_schema.schema.properties.overrides.properties.gapWidth).toEqual({ type: ["number", "null"] });
  });
  it("clamps, rounds, drops nulls/defaults and rejects incompatible settings", async () => {
    llm({ taskFamily: "push_through_gap", overrides: { gapWidth: 0.5, cubeDx: -5, cubeDy: 0.026, dividerHeight: 0.2, speedScale: 1, targetDx: null }, explanation: "ignored" });
    expect(await run()).toMatchObject({ mode: "llm", status: "matched", overrides: { gapWidth: 0.2, cubeDx: -0.1, cubeDy: 0.025 } });
    const result = await run();
    if (result.status === "matched") expect(Object.keys(result.overrides)).toHaveLength(3);
  });
  it.each(["unsupported", "drone_landing", "constructor", "__proto__"])("does not invent family %s", async (family) => {
    llm({ taskFamily: family, overrides: {}, explanation: "invented" });
    expect(await run()).toMatchObject({ mode: "llm", status: "unsupported" });
  });
  it.each([
    { taskFamily: "push_through_gap", overrides: { gapWidth: "0.07" }, explanation: "bad" },
    { taskFamily: "push_through_gap", overrides: { gapWidth: {} }, explanation: "bad" },
    { taskFamily: "push_through_gap", overrides: {} },
  ])("falls back on malformed untrusted model output", async (value) => {
    llm(value);
    expect(await run()).toEqual({ mode: "rules", fallback: true, ...rules(text) });
  });
  it("falls back on network error or non-200 response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-placeholder");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await run()).toEqual({ mode: "rules", fallback: true, ...rules(text) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 429 })));
    expect(await run()).toEqual({ mode: "rules", fallback: true, ...rules(text) });
  });
  it("falls back on invalid JSON, missing choices and model refusal", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-placeholder");
    for (const body of ["not-json", JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { refusal: "no" } }] }), JSON.stringify({ choices: [{ message: { content: "not-json" } }] })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      expect(await run()).toEqual({ mode: "rules", fallback: true, ...rules(text) });
    }
  });
  it("falls back within 15 seconds even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENAI_API_KEY", "test-placeholder");
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => { signal = options.signal; started(); return new Promise(() => {}); }));
    const result = run();
    await fetching;
    expect(DESCRIBE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    await vi.advanceTimersByTimeAsync(DESCRIBE_TIMEOUT_MS);
    expect(await result).toEqual({ mode: "rules", fallback: true, ...rules(text) });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
