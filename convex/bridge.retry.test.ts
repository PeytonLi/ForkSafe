import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./bridge.js";
import { SpacetimeReducerError } from "./lib/spacetime.js";

const env = {
  SPACETIMEDB_MODE: "cloud",
  SPACETIMEDB_URI: "https://spacetime.example.invalid",
  SPACETIMEDB_DATABASE: "forksafe",
  FORKSAFE_BRIDGE_SECRET: "bridge-secret",
};

function fakeCtx() {
  return {
    runQuery: vi.fn(async () => ({ token: "bridge-token", identity: "bridge-identity" })),
    runMutation: vi.fn(async () => undefined),
  } as any;
}

const args = { id: "evaluation-1", grant: { grantId: "grant-1", attemptId: "attempt-1", epoch: 3 } };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BridgeClient transient retries", () => {
  it("retries a 530 and commits with the same reducer arguments", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 530 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    const pending = new BridgeClient(fakeCtx(), env).call("record_evaluation", args);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ committed: true, mode: "live" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ id: "evaluation-1", grant: { grant_id: "grant-1", attempt_id: "attempt-1", epoch: 3 } }),
      JSON.stringify({ id: "evaluation-1", grant: { grant_id: "grant-1", attempt_id: "attempt-1", epoch: 3 } }),
    ]);
  });

  it("does not retry a 409 stale_epoch rejection", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("stale_epoch: grant is stale", { status: 409 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(new BridgeClient(fakeCtx(), env).call("record_evaluation", args))
      .rejects.toBeInstanceOf(SpacetimeReducerError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns spacetime_unavailable after four 530 responses", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response("upstream unavailable", { status: 530 }));
    vi.stubGlobal("fetch", fetcher);

    const pending = new BridgeClient(fakeCtx(), env).call("record_evaluation", args);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ committed: false, mode: "live", reason: "spacetime_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("retries network errors", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    const pending = new BridgeClient(fakeCtx(), env).call("record_evaluation", args);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ committed: true, mode: "live" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
