import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { initTelemetry } from "@forksafe/telemetry";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("injects traceparent without changing the signed job-source request", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318");
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry({
      serviceName: "forksafe-runner-http-test",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
      spanExporter: exporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
        exportIntervalMillis: 60_000,
      }),
    });
    const secret = "test-secret";
    let jobRequest: RequestInit | undefined;
    let toolRequest: RequestInit | undefined;
    const source = new HttpJobSource("https://runner.invalid", secret, async (_input, init) => {
      jobRequest = init;
      return new Response(JSON.stringify({ lease: null }), { status: 200 });
    });
    const now = Date.now();
    const lease = sampleLease(now);
    const toolBackend = new HttpToolBackend("https://runner.invalid", secret, lease, async (_input, init) => {
      toolRequest = init;
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }, () => now);
    let expectedTraceparent = "";
    await telemetry.withSpan("runner.claim", {}, async (span) => {
      expectedTraceparent = `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`;
      await source.claim({ workerId: "test", kinds: ["factory_session"], capacity: 1 });
      await toolBackend.run_experiment({
        caseId: crypto.randomUUID(),
        seed: 1,
        hypothesis: "test",
      }, {
        investigationId: lease.job.investigationId,
        environmentId: lease.job.environmentId!,
        sessionId: crypto.randomUUID(),
        attemptId: lease.attempt.id,
        grantId: lease.grant.id,
        epoch: lease.attempt.epoch,
      });
    });
    await telemetry.shutdown();

    expectTimestampBoundSignature(jobRequest, secret);
    expectTimestampBoundSignature(toolRequest, secret);
    expect(new Headers(jobRequest?.headers).get("traceparent")).toBe(expectedTraceparent);
    expect(new Headers(toolRequest?.headers).get("traceparent")).toBe(expectedTraceparent);
  });

  it("does not inject traceparent when telemetry is disabled", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const secret = "test-secret";
    let jobRequest: RequestInit | undefined;
    let toolRequest: RequestInit | undefined;
    const source = new HttpJobSource("https://runner.invalid", secret, async (_input, init) => {
      jobRequest = init;
      return new Response(JSON.stringify({ lease: null }), { status: 200 });
    });
    const now = Date.now();
    const lease = sampleLease(now);
    const toolBackend = new HttpToolBackend("https://runner.invalid", secret, lease, async (_input, init) => {
      toolRequest = init;
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }, () => now);
    await source.claim({ workerId: "test", kinds: ["factory_session"], capacity: 1 });
    await toolBackend.run_experiment({
      caseId: crypto.randomUUID(),
      seed: 1,
      hypothesis: "test",
    }, {
      investigationId: lease.job.investigationId,
      environmentId: lease.job.environmentId!,
      sessionId: crypto.randomUUID(),
      attemptId: lease.attempt.id,
      grantId: lease.grant.id,
      epoch: lease.attempt.epoch,
    });

    expectTimestampBoundSignature(jobRequest, secret);
    expectTimestampBoundSignature(toolRequest, secret);
    expect(new Headers(jobRequest?.headers).has("traceparent")).toBe(false);
    expect(new Headers(toolRequest?.headers).has("traceparent")).toBe(false);
  });
});
