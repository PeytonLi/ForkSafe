import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpJobSource } from "../src/job-source.js";
import { HttpToolBackend } from "../src/tool-backend.js";
import { sampleLease } from "./helpers.js";

function expectTimestampBoundSignature(request: RequestInit | undefined, secret: string): void {
  const headers = new Headers(request?.headers);
  const timestamp = headers.get("x-forksafe-timestamp");
  const body = String(request?.body);
  expect(timestamp).toBeTruthy();
  expect(headers.get("x-forksafe-signature")).toBe(
    createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"),
  );
}

describe("HTTP request signatures", () => {
  it("signs the timestamp and exact JSON body for job-source requests", async () => {
    const secret = "test-secret";
    let request: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({ lease: null }), { status: 200 });
    };
    const source = new HttpJobSource("https://runner.invalid", secret, fetcher);

    await source.claim({ workerId: "test", kinds: ["factory_session"], capacity: 1 });

    expectTimestampBoundSignature(request, secret);
  });

  it("signs the timestamp and exact JSON body for tool requests", async () => {
    const secret = "test-secret";
    let request: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({ mode: "fixture" }), { status: 200 });
    };
    const now = Date.now();
    const lease = sampleLease(now);
    const backend = new HttpToolBackend("https://runner.invalid", secret, lease, fetcher, () => now);

    await backend.run_experiment(
      { caseId: crypto.randomUUID(), seed: 1, hypothesis: "test" },
      {
        investigationId: lease.job.investigationId,
        environmentId: lease.job.environmentId!,
        sessionId: crypto.randomUUID(),
        attemptId: lease.attempt.id,
        grantId: lease.grant.id,
        epoch: lease.attempt.epoch,
      },
    );

    expectTimestampBoundSignature(request, secret);
  });
});
