"""Optional OpenTelemetry integration — the core stays zero-dependency.

Nothing here imports the OpenTelemetry SDK: pass the ``tracer`` / ``meter``
you already have and this emits a ``unswallow.check`` span plus
low-cardinality recovery metrics. With neither passed it is a no-op.

Example::

    from opentelemetry import trace, metrics
    from unswallow import check_and_rescue, observe_check_result

    result = check_and_rescue(response)
    observe_check_result(
        result,
        tracer=trace.get_tracer("app"),
        meter=metrics.get_meter("app"),
    )
"""

from __future__ import annotations

from typing import Any

from ..types import SwallowCheckResult


def observe_check_result(
    result: SwallowCheckResult,
    tracer: Any = None,
    meter: Any = None,
    recovery_latency_ms: Any = None,
    audit_log: Any = None,
) -> None:
    """Emit an OTel span and recovery metrics for one check result, if available."""
    if callable(audit_log):
        audit_log({"type": "unswallow.check", "result": result})
    attrs = {
        "detected": bool(result.detected),
        "pattern": result.pattern or "none",
        "recovered": bool(result.recovered),
        "confidence": float(result.confidence),
        "engine": (result.matrix_match.engine if result.matrix_match else result.engine_hint) or "unknown",
        "name_known": result.validation.name_known if result.validation else "unknown",
        "schema_valid": result.validation.schema_valid if result.validation else "unknown",
    }
    if tracer is not None:
        span = tracer.start_span("unswallow.check")
        set_attrs = getattr(span, "set_attributes", None)
        if callable(set_attrs):
            set_attrs(attrs)
        span.end()
    if meter is not None:
        metric_attrs = {
            "engine": str(attrs["engine"]),
            "pattern": str(attrs["pattern"]),
            "name_known": str(attrs["name_known"]),
            "schema_valid": str(attrs["schema_valid"]),
        }
        meter.create_counter("swallowed_tool_calls_total", description="Responses where a swallowed tool-call pattern was detected").add(1 if result.detected else 0, metric_attrs)
        meter.create_counter("recovered_tool_calls_total", description="Tool calls recovered from structurally valid envelopes").add(len(result.tool_calls or []) if result.recovered else 0, metric_attrs)
        blocked = result.detected and not result.recovered and result.pattern != "C"
        meter.create_counter("false_positive_guard_total", description="Detections withheld by a recovery safety gate").add(1 if blocked else 0, metric_attrs)
        if result.pattern:
            meter.create_counter("pattern_{}_total".format(result.pattern.lower()), description="Detected Pattern {} responses".format(result.pattern)).add(1 if result.detected else 0, metric_attrs)
        if isinstance(recovery_latency_ms, (int, float)) and recovery_latency_ms >= 0:
            histogram = getattr(meter, "create_histogram", None)
            if callable(histogram):
                histogram("recovery_latency_ms", description="Wall-clock time measured by the caller around check and recovery", unit="ms").record(recovery_latency_ms, metric_attrs)
