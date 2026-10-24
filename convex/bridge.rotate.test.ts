import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, reducerMissing } from "./bridge.js";

const env = { SPACETIMEDB_MODE: "cloud", SPACETIMEDB_URI: "https://spacetime.example.invalid", SPACETIMEDB_DATABASE: "forksafe", FORKSAFE_BRIDGE_SECRET: "s3cret" };

function fakeCtx() {
  const saved: Record<string, unknown>[] = [];
  return {
    saved,
    ctx: {
      runQuery: vi.fn(async () => ({ token: "stored-token", identity: "c0ffee" })),
      runMutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => { saved.push(args); }),
    } as any,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bridge identity registration", () => {
  it("rotates the stored identity in with rotate_bridge_identity and never calls register_bridge", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      expect(JSON.parse(String(init.body))).toEqual({ secret: "s3cret" });
      return new Response("", { status: 200 });
    }));
    const { ctx, saved } = fakeCtx();
    await expect(new BridgeClient(ctx, env).register()).resolves.toEqual({ mode: "live", identity: "c0ffee" });
    expect(calls).toEqual(["https://spacetime.example.invalid/v1/database/forksafe/call/rotate_bridge_identity"]);
    expect(saved.at(-1)).toMatchObject({ healthy: true, identity: "c0ffee" });
  });

  it("falls back to register_bridge while Maincloud lacks the new reducer", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url.split("/").pop()!);
      return url.endsWith("rotate_bridge_identity") ? new Response("No such procedure", { status: 404 }) : new Response("", { status: 200 });
    }));
    await new BridgeClient(fakeCtx().ctx, env).register();
    expect(calls).toEqual(["rotate_bridge_identity", "register_bridge"]);
  });

  it("does not fall back on a secret mismatch and records only the error code", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const fetcher = vi.fn(async () => new Response("bridge_secret_mismatch: Bridge secret does not match", { status: 530 }));
    vi.stubGlobal("fetch", fetcher);
    const { ctx, saved } = fakeCtx();
    await expect(new BridgeClient(ctx, env).register()).rejects.toMatchObject({ code: "bridge_secret_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(saved)).not.toContain("s3cret");
  });

  it("classifies only missing-procedure replies as a missing reducer", () => {
    expect(reducerMissing(404, "No such procedure")).toBe(true);
    expect(reducerMissing(530, "No such reducer rotate_bridge_identity")).toBe(true);
    expect(reducerMissing(530, "bridge_secret_mismatch: nope")).toBe(false);
    expect(reducerMissing(401, "")).toBe(false);
  });
});
