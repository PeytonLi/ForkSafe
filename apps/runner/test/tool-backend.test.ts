import { describe, expect, it, vi } from "vitest";
import { HttpToolBackend } from "../src/tool-backend.js";
import { sampleLease } from "./helpers.js";

describe("HttpToolBackend", () => {
  it("reuses one call id and signed body across network retries", async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error("network unavailable");
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });
    const backend = new HttpToolBackend("https://control.invalid", "test-secret", sampleLease(), fetcher as typeof fetch);
    const callId = crypto.randomUUID();
    const result = await backend.inspect_failure({}, {
      investigationId: crypto.randomUUID(), environmentId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(), grantId: crypto.randomUUID(), epoch: 0, callId,
    });
    expect(result).toEqual({ status: "ok" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!).callId).toBe(callId);
  });
});
