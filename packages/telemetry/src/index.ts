import {
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type MetricReader,
  type ResourceMetrics,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

const ALLOWED_ATTRIBUTES = new Set([
  "forksafe.investigation_id", "forksafe.environment_id", "forksafe.job_id",
  "forksafe.attempt_id", "forksafe.grant_id", "forksafe.epoch", "forksafe.session_id",
  "forksafe.vendor_session_id", "forksafe.turn.index", "forksafe.turn.mode",
  "forksafe.turn.success", "forksafe.turn.tool_calls", "forksafe.tokens.known",
  "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "forksafe.tokens.cache_read",
  "forksafe.tokens.cache_creation", "forksafe.tokens.thinking", "forksafe.factory_credits",
  "forksafe.tool.name", "forksafe.tool.status", "forksafe.tool.is_error", "forksafe.outcome",
  "forksafe.completion.accepted", "forksafe.completion.attempts",
  "forksafe.candidate_submitted", "forksafe.artifacts.count", "forksafe.lease.abort_reason",
  "forksafe.eval.suite", "forksafe.eval.candidate_id", "forksafe.eval.case_id",
  "forksafe.eval.case_index", "forksafe.eval.case_status", "forksafe.eval.status",
  "forksafe.eval.cases", "http.request.method", "http.response.status_code", "url.path",
  "error.type",
]);

const METRIC_ATTRIBUTES = new Set([
  "forksafe.token.kind", "forksafe.tool.name", "forksafe.eval.suite", "forksafe.eval.status",
]);

const NOOP_SPAN = {
  addEvent() { return this; },
  addLink() { return this; },
  addLinks() { return this; },
  end() {},
  isRecording() { return false; },
  recordException() {},
  setAttribute() { return this; },
  setAttributes() { return this; },
  setStatus() { return this; },
  spanContext() { return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }; },
  updateName() { return this; },
} as Span;

export function safeAttributes(attrs: Record<string, unknown>): Attributes {
  const safe: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!ALLOWED_ATTRIBUTES.has(key)) continue;
    if (typeof value === "string") {
      const filtered = key === "url.path" ? value.split(/[?#]/, 1)[0] ?? "" : value;
      safe[key] = filtered.slice(0, 256);
    }
    else if (typeof value === "boolean") safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

function metricAttributes(attrs: Record<string, unknown>): Attributes {
  const safe: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!METRIC_ATTRIBUTES.has(key)) continue;
    if (typeof value === "string") safe[key] = value.slice(0, 256);
    else if (typeof value === "boolean") safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

export function tokenAttributes(usage: object | null): Attributes {
  if (!usage) return { "forksafe.tokens.known": false };
  const attrs: Record<string, unknown> = { "forksafe.tokens.known": true };
  const usageFields = usage as Record<string, unknown>;
  const tokenFields = [
    ["inputTokens", "gen_ai.usage.input_tokens"],
    ["outputTokens", "gen_ai.usage.output_tokens"],
    ["cacheReadTokens", "forksafe.tokens.cache_read"],
    ["cacheCreationTokens", "forksafe.tokens.cache_creation"],
    ["thinkingTokens", "forksafe.tokens.thinking"],
    ["factoryCredits", "forksafe.factory_credits"],
  ] as const;
  for (const [source, target] of tokenFields) {
    const value = usageFields[source];
    if (typeof value === "number" && Number.isFinite(value)) attrs[target] = value;
  }
  return safeAttributes(attrs);
}

export function injectTraceHeaders(
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_SDK_DISABLED === "true") return { ...headers };
  const active = trace.getSpan(context.active());
  if (!active?.spanContext().traceId) return { ...headers };
  const injected = { ...headers };
  propagation.inject(context.active(), injected);
  return injected;
}

export class RedactingSpanExporter implements SpanExporter {
  constructor(
    private readonly exporter: SpanExporter,
    private readonly secrets: string[] = [],
  ) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    const secrets = this.secrets.filter((secret) => secret.length >= 8);
    this.exporter.export(spans.map((span) => {
      const name = secrets.reduce((safeName, secret) => safeName.split(secret).join("[REDACTED]"), span.name);
      const events = span.events
        .filter((event) => event.name !== "exception")
        .map((event) => ({ ...event, attributes: safeAttributes(event.attributes ?? {}) }));
      return {
        name,
        kind: span.kind,
        spanContext: () => span.spanContext(),
        parentSpanContext: span.parentSpanContext,
        startTime: span.startTime,
        endTime: span.endTime,
        duration: span.duration,
        ended: span.ended,
        attributes: safeAttributes(span.attributes),
        links: span.links.map((link) => ({
          ...link,
          attributes: safeAttributes(link.attributes ?? {}),
        })),
        events,
        status: { ...span.status, message: "" },
        resource: span.resource,
        instrumentationScope: span.instrumentationScope,
        droppedAttributesCount: span.droppedAttributesCount,
        droppedEventsCount: span.droppedEventsCount,
        droppedLinksCount: span.droppedLinksCount,
      };
    }), resultCallback);
  }

  async shutdown(): Promise<void> {
    await this.exporter.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush?.();
  }
}

class RedactingMetricExporter implements PushMetricExporter {
  constructor(private readonly exporter: PushMetricExporter) {}

  export(metrics: ResourceMetrics, resultCallback: Parameters<PushMetricExporter["export"]>[1]): void {
    const redacted = {
      ...metrics,
      scopeMetrics: metrics.scopeMetrics.map((scopeMetric) => ({
        ...scopeMetric,
        metrics: scopeMetric.metrics.map((metric) => ({
          ...metric,
          dataPoints: metric.dataPoints.map((point) => ({
            ...point,
            attributes: metricAttributes(point.attributes as Record<string, unknown>),
          })),
        })),
      })),
    } as unknown as ResourceMetrics;
    this.exporter.export(redacted, resultCallback);
  }

  selectAggregationTemporality(
    instrumentType: Parameters<NonNullable<PushMetricExporter["selectAggregationTemporality"]>>[0],
  ) {
    return this.exporter.selectAggregationTemporality?.(instrumentType)
      ?? AggregationTemporality.CUMULATIVE;
  }

  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush?.();
  }

  async shutdown(): Promise<void> {
    await this.exporter.shutdown();
  }
}

export interface Telemetry {
  enabled: boolean;
  mode: "otlp" | "disabled";
  withSpan<T>(
    name: string,
    attrs: Record<string, unknown>,
    fn: (span: Span) => T | Promise<T>,
    options?: { parent?: Context },
  ): Promise<T>;
  startSpan(name: string, attrs?: Record<string, unknown>, parent?: Context): {
    span: Span;
    context: Context;
    end: () => void;
  };
  injectTraceHeaders(headers: Record<string, string>): Record<string, string>;
  metrics: {
    turnActive(delta: number): void;
    recordTokens(usage: object | null): void;
    setSandboxes(callback: () => number | undefined): void;
    setOutboxBacklog(callback: () => number | undefined): void;
    recordEvaluationDuration(seconds: number, attrs: Record<string, unknown>): void;
    forceFlush(): Promise<void>;
  };
  shutdown(): Promise<void>;
}

export function initTelemetry(options: {
  serviceName: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  spanExporter?: SpanExporter;
  metricReader?: MetricReader;
  secrets?: string[];
}): Telemetry {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const enabled = Boolean(endpoint) && env.OTEL_SDK_DISABLED !== "true";
  let sdk: NodeSDK | undefined;
  let activeMetricReader: MetricReader | undefined;

  if (enabled) {
    const resource = resourceFromAttributes({
      "service.name": options.serviceName,
      "deployment.environment": env.FORKSAFE_DEPLOYMENT_ENVIRONMENT ?? "dev",
    });
    const traceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ?? `${endpoint!.replace(/\/$/, "")}/v1/traces`;
    const metricEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
      ?? `${endpoint!.replace(/\/$/, "")}/v1/metrics`;
    const traceExporter = options.spanExporter ?? new OTLPTraceExporter({
      url: traceEndpoint,
      headers: parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
    });
    const metricExporter = new OTLPMetricExporter({
      url: metricEndpoint,
      headers: parseHeaders(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
    });
    activeMetricReader = options.metricReader ?? new PeriodicExportingMetricReader({
      exporter: new RedactingMetricExporter(metricExporter),
      exportIntervalMillis: 10_000,
    });
    sdk = new NodeSDK({
      resource,
      autoDetectResources: false,
      spanProcessors: [new BatchSpanProcessor(new RedactingSpanExporter(traceExporter, options.secrets))],
      metricReader: activeMetricReader,
    });
    sdk.start();
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  }

  const tracer = enabled ? trace.getTracer(options.serviceName) : undefined;
  const meter = enabled ? metrics.getMeter(options.serviceName) : undefined;
  const turnsActive = meter?.createUpDownCounter("forksafe.turns.active");
  const tokens = meter?.createCounter("forksafe.tokens");
  const usageUnknown = meter?.createCounter("forksafe.turns.usage_unknown");
  const duration = meter?.createHistogram("forksafe.evaluation.duration", { unit: "s" });
  let sandboxCount: (() => number | undefined) | undefined;
  let outboxCount: (() => number | undefined) | undefined;
  const sandboxes = meter?.createObservableGauge("forksafe.sandboxes.active");
  sandboxes?.addCallback((result) => {
    const value = sandboxCount?.();
    if (value !== undefined && Number.isFinite(value)) result.observe(value);
  });
  const backlog = meter?.createObservableGauge("forksafe.outbox.backlog");
  backlog?.addCallback((result) => {
    const value = outboxCount?.();
    if (value !== undefined && Number.isFinite(value)) result.observe(value);
  });

  const telemetry: Telemetry = {
    enabled,
    mode: enabled ? "otlp" : "disabled",
    async withSpan(name, attrs, fn, spanOptions = {}) {
      if (!tracer) return fn(NOOP_SPAN);
      return tracer.startActiveSpan(name, {
        kind: SpanKind.INTERNAL,
        attributes: safeAttributes(attrs),
      }, spanOptions.parent ?? context.active(), async (span) => {
        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          const type = error instanceof Error && error.name ? error.name : "Error";
          span.setAttribute("error.type", type);
          span.setStatus({ code: SpanStatusCode.ERROR, message: "" });
          throw error;
        } finally {
          span.end();
        }
      });
    },
    startSpan(name, attrs = {}, parent) {
      const parentContext = parent ?? context.active();
      if (!tracer) return { span: NOOP_SPAN, context: parentContext, end: () => undefined };
      const span = tracer.startSpan(name, { attributes: safeAttributes(attrs) }, parentContext);
      const spanContext = trace.setSpan(parentContext, span);
      return { span, context: spanContext, end: () => span.end() };
    },
    injectTraceHeaders(headers) {
      return injectTraceHeaders(headers, env);
    },
    metrics: {
      turnActive(delta) {
        if (Number.isFinite(delta)) turnsActive?.add(delta);
      },
      recordTokens(usage) {
        if (!enabled) return;
        if (!usage) {
          usageUnknown?.add(1);
          return;
        }
        for (const [source, kind] of [
          ["inputTokens", "input"],
          ["outputTokens", "output"],
          ["cacheReadTokens", "cache_read"],
          ["cacheCreationTokens", "cache_creation"],
          ["thinkingTokens", "thinking"],
        ] as const) {
          const value = (usage as Record<string, unknown>)[source];
          if (typeof value === "number" && Number.isFinite(value)) {
            tokens?.add(value, metricAttributes({ "forksafe.token.kind": kind }));
          }
        }
      },
      setSandboxes(callback) { sandboxCount = callback; },
      setOutboxBacklog(callback) { outboxCount = callback; },
      recordEvaluationDuration(seconds, attrs) {
        if (Number.isFinite(seconds)) duration?.record(seconds, metricAttributes(attrs));
      },
      async forceFlush() {
        try { await activeMetricReader?.forceFlush(); } catch { /* best-effort flush */ }
      },
    },
    async shutdown() {
      if (!sdk) return;
      const shutdown = sdk.shutdown().catch(() => undefined);
      await Promise.race([
        shutdown,
        new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 5_000);
          timeout.unref();
        }),
      ]);
    },
  };
  return telemetry;
}

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(value.split(",").flatMap((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [[part.slice(0, index).trim(), part.slice(index + 1).trim()]] : [];
  }));
}
