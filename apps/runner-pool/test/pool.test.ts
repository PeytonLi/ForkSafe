import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerPool, type RunnerClaim } from "../src/pool.js";

const token = "pool-token-must-not-reach-child";
const claim: RunnerClaim = {
  credentialId: "credential-id",
  secret: "scoped-runner-secret",
  environmentId: "environment-id",
  investigationId: "investigation-id",
  jobSourceUrl: "https://example.convex.site",
  controlUrl: "https://example.convex.site",
  expiresAtMs: 123,
};

class FakeChild extends EventEmitter {
  signals: string[] = [];
  kill(signal = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal !== "SIGKILL") this.emit("exit", 0, null);
    else this.emit("exit", null, signal);
    return true;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("runner pool", () => {
  it("claims and spawns one runner with scoped credentials only in its environment", async () => {
    let spawnOptions: SpawnOptions | undefined;
    const logs: string[] = [];
    const spawnRunner = vi.fn((_entry: string, options: SpawnOptions) => {
      spawnOptions = options;
      return new FakeChild() as unknown as ChildProcess;
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(claim), { status: 200 }));
    const pool = new RunnerPool({
      convexSiteUrl: "https://example.convex.site/",
      token,
      fetcher,
      spawnRunner,
      logger: (message) => logs.push(message),
      workRoot: "/tmp/runner-pool-test",
    });

    await expect(pool.tick()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://example.convex.site/runner/pool/claim", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
    }));
    expect(spawnOptions?.env).toMatchObject({
      RUNNER_CALLBACK_SECRET: claim.secret,
      RUNNER_CREDENTIAL_ID: claim.credentialId,
      RUNNER_JOB_SOURCE_URL: claim.jobSourceUrl,
      RUNNER_CONTROL_URL: claim.controlUrl,
    });
    expect(spawnOptions?.env).not.toHaveProperty("RUNNER_POOL_TOKEN");
    expect(logs.join(" ")).not.toContain(claim.secret);
  });

  it("does not claim past the configured runner cap", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(claim), { status: 200 }));
    const pool = new RunnerPool({
      convexSiteUrl: "https://example.convex.site",
      token,
      maxRunners: 1,
      fetcher,
      spawnRunner: () => new FakeChild() as unknown as ChildProcess,
      workRoot: "/tmp/runner-pool-cap-test",
    });

    await pool.tick();
    await expect(pool.tick()).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(pool.activeRunners).toBe(1);
  });

  it("forwards termination and releases a runner after its child drains", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    let child: FakeChild | undefined;
    const pool = new RunnerPool({
      convexSiteUrl: "https://example.convex.site",
      token,
      fetcher: vi.fn(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body ?? "") });
        return String(input).endsWith("/claim")
          ? new Response(JSON.stringify(claim), { status: 200 })
          : new Response(JSON.stringify({ released: true }), { status: 200 });
      }),
      spawnRunner: () => (child = new FakeChild()) as unknown as ChildProcess,
      workRoot: "/tmp/runner-pool-drain-test",
    });

    await pool.tick();
    await pool.stop(100);
    expect(child?.signals).toEqual(["SIGTERM"]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.convex.site/runner/pool/claim",
      "https://example.convex.site/runner/pool/release",
    ]);
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ credentialId: claim.credentialId });
    expect(pool.activeRunners).toBe(0);
  });
});
