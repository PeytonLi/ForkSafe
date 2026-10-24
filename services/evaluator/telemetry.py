from __future__ import annotations

import logging
import math
import os
import time
from contextlib import contextmanager
from typing import Any, Iterator, Mapping

logger = logging.getLogger(__name__)

ALLOWED_ATTRIBUTES = frozenset({
    "forksafe.investigation_id",
    "forksafe.environment_id",
    "forksafe.job_id",
    "forksafe.attempt_id",
    "forksafe.grant_id",
    "forksafe.epoch",
    "forksafe.session_id",
    "forksafe.vendor_session_id",
    "forksafe.turn.index",
    "forksafe.turn.mode",
    "forksafe.turn.success",
    "forksafe.turn.tool_calls",
    "forksafe.tokens.known",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "forksafe.tokens.cache_read",
    "forksafe.tokens.cache_creation",
    "forksafe.tokens.thinking",
    "forksafe.factory_credits",
    "forksafe.tool.name",
    "forksafe.tool.status",
    "forksafe.tool.is_error",
    "forksafe.outcome",
    "forksafe.completion.accepted",
    "forksafe.completion.attempts",
    "forksafe.candidate_submitted",
    "forksafe.artifacts.count",
    "forksafe.lease.abort_reason",
    "forksafe.eval.suite",
    "forksafe.eval.candidate_id",
    "forksafe.eval.case_id",
    "forksafe.eval.case_index",
    "forksafe.eval.case_status",
    "forksafe.eval.status",
    "forksafe.eval.cases",
    "http.request.method",
    "http.response.status_code",
    "url.path",
    "error.type",
})

METRIC_ATTRIBUTES = frozenset({
    "forksafe.token.kind",
    "forksafe.tool.name",
    "forksafe.eval.suite",
    "forksafe.eval.status",
})

_MISSING_OTEL_LOGGED = False


def safe_attributes(attributes: dict[str, Any]) -> dict[str, str | int | float | bool]:
    safe: dict[str, str | int | float | bool] = {}
    for key, value in attributes.items():
        if key not in ALLOWED_ATTRIBUTES:
            continue
        if isinstance(value, str):
            filtered = value.split("?", 1)[0].split("#", 1)[0] if key == "url.path" else value
            safe[key] = filtered[:256]
        elif isinstance(value, bool):
            safe[key] = value
        elif isinstance(value, (int, float)) and math.isfinite(value):
            safe[key] = value
    return safe


class EvaluatorTelemetry:
    def __init__(self, provider: Any = None, meter_provider: Any = None, propagator: Any = None) -> None:
        self.enabled = provider is not None
        self._provider = provider
        self._meter_provider = meter_provider
        self._propagator = propagator
        self._tracer = provider.get_tracer("forksafe-evaluator") if provider else None
        meter = meter_provider.get_meter("forksafe-evaluator") if meter_provider else None
        self._duration = meter.create_histogram("forksafe.evaluation.duration", unit="s") if meter else None

    @contextmanager
    def span(self, name: str, attributes: dict[str, Any], parent: Any = None) -> Iterator[Any]:
        if not self._tracer:
            yield _NoopSpan()
            return
        clean = safe_attributes(attributes)
        with self._tracer.start_as_current_span(
            name,
            context=parent,
            attributes=clean,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                yield span
            except BaseException as error:
                span.set_attribute("error.type", type(error).__name__)
                from opentelemetry.trace import Status, StatusCode

                span.set_status(Status(StatusCode.ERROR))
                raise

    def extract_traceparent(self, value: str | None) -> Any:
        if not self._propagator or not value:
            return None
        return self._propagator.extract({"traceparent": value})

    def record_duration(self, seconds: float, attributes: dict[str, Any]) -> None:
        if self._duration and math.isfinite(seconds):
            self._duration.record(seconds, safe_attributes(attributes))

    def shutdown(self) -> None:
        if self._provider:
            try:
                self._provider.force_flush(timeout_millis=5_000)
                self._provider.shutdown()
            except Exception:
                logger.warning("OpenTelemetry tracer shutdown failed")
        if self._meter_provider:
            try:
                self._meter_provider.force_flush(timeout_millis=5_000)
                self._meter_provider.shutdown()
            except Exception:
                logger.warning("OpenTelemetry meter shutdown failed")


class _NoopSpan:
    def set_attribute(self, _key: str, _value: Any) -> None:
        return


def init_telemetry(
    env: Mapping[str, str] | None = None,
    span_exporter: Any = None,
    metric_reader: Any = None,
) -> EvaluatorTelemetry:
    environment = env if env is not None else os.environ
    endpoint = environment.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint or environment.get("OTEL_SDK_DISABLED") == "true":
        return EvaluatorTelemetry()
    try:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

        headers = dict(
            part.split("=", 1)
            for part in environment.get("OTEL_EXPORTER_OTLP_HEADERS", "").split(",")
            if "=" in part
        )
        resource = Resource.create({
            "service.name": "forksafe-evaluator",
            "deployment.environment": environment.get("FORKSAFE_DEPLOYMENT_ENVIRONMENT", "dev"),
        })
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(BatchSpanProcessor(span_exporter or OTLPSpanExporter(
            endpoint=f"{endpoint.rstrip('/')}/v1/traces",
            headers=headers,
        )))
        reader = metric_reader or PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=f"{endpoint.rstrip('/')}/v1/metrics", headers=headers),
            export_interval_millis=10_000,
        )
        meter_provider = MeterProvider(resource=resource, metric_readers=[reader])
        return EvaluatorTelemetry(provider, meter_provider, TraceContextTextMapPropagator())
    except ImportError:
        global _MISSING_OTEL_LOGGED
        if not _MISSING_OTEL_LOGGED:
            logger.warning("OpenTelemetry dependencies are unavailable; evaluator telemetry is disabled")
            _MISSING_OTEL_LOGGED = True
        return EvaluatorTelemetry()
