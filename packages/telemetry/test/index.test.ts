import { describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { countPendingOutboxRows } from "../src/ops-gauges.js";
import { initTelemetry, safeAttributes, tokenAttributes } from "../src/index.js";

class PreservingSpanExporter extends InMemorySpanExporter {
  override async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

describe("telemetry", () => {
  it("stays disabled without an endpoint and does not inject trace headers", async () => {
    const exporter = new PreservingSpanExporter();
    const telemetry = initTelemetry({
      serviceName: "forksafe-test",
      env: {},
      spanExporter: exporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
        exportIntervalMillis: 60_000,
      }),
    });
    expect(telemetry.mode).toBe("disabled");
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.injectTraceHeaders({ "content-type": "application/json" })).toEqual({
      "content-type": "application/json",
    });
    await telemetry.withSpan("runner.job", { prompt: "private" }, (span) => {
      span.setAttribute("forksafe.job_id", "job");
    });
    await telemetry.shutdown();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it("counts only pending outbox rows and rejects malformed output", () => {
    expect(countPendingOutboxRows([
      JSON.stringify({ status: "pending" }),
      JSON.stringify({ status: "complete" }),
      JSON.stringify({ status: "pending" }),
    ].join("\n"))).toBe(2);
    expect(countPendingOutboxRows("not-json")).toBeUndefined();
  });

  it("redacts exported spans, injects W3C context, and omits unknown token counts", async () => {
    const exporter = new PreservingSpanExporter();
    const metricReader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    const secret = ["private", "fragment"].join("-");
    const telemetry = initTelemetry({
      serviceName: "forksafe-test",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
      spanExporter: exporter,
      metricReader,
      secrets: [secret],
    });
    let expectedTraceparent = "";
    let injected: Record<string, string> = {};

    await telemetry.withSpan(`runner.job-${secret}`, {
      "forksafe.job_id": "job-123",
      prompt: "private prompt",
      authorization: "private header",
    }, (span) => {
      const spanContext = span.spanContext();
      expectedTraceparent = `00-${spanContext.traceId}-${spanContext.spanId}-01`;
      injected = telemetry.injectTraceHeaders({});
      span.addEvent("exception", { "exception.message": "private failure" });
      span.setStatus({ code: SpanStatusCode.ERROR, message: "private status" });
    });
    await expect(telemetry.withSpan("runner.failure", {}, () => {
      throw new Error("private failure text");
    })).rejects.toThrow("private failure text");
    await telemetry.shutdown();

    expect(injected.traceparent).toBe(expectedTraceparent);
    expect(injected.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const spans = exporter.getFinishedSpans();
    const job = spans.find((span) => span.name.startsWith("runner.job"));
    expect(job?.name).toBe("runner.job-[REDACTED]");
    expect(job?.attributes).toEqual({ "forksafe.job_id": "job-123" });
    expect(job?.events).toEqual([]);
    expect(job?.status.message).toBe("");
    const failure = spans.find((span) => span.name === "runner.failure");
    expect(failure?.attributes["error.type"]).toBe("Error");
    expect(failure?.status.message).toBe("");
    expect(JSON.stringify(spans)).not.toContain("private failure text");
    expect(tokenAttributes(null)).toEqual({ "forksafe.tokens.known": false });
    expect(Object.keys(tokenAttributes(null))).not.toContain("gen_ai.usage.input_tokens");
    expect(safeAttributes({
      "forksafe.job_id": "x".repeat(300),
      "forksafe.epoch": Number.POSITIVE_INFINITY,
      "forksafe.tool.name": ["array", "value"],
      "url.path": "/runner/jobs?private=query",
      prompt: "must not appear",
    })).toEqual({ "forksafe.job_id": "x".repeat(256), "url.path": "/runner/jobs" });
  });
});
