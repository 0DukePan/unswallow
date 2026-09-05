"""Optional OpenTelemetry integration — the core stays zero-dependency.

Nothing here imports the OpenTelemetry SDK: pass the ``tracer`` / ``meter``
you already have and this emits a ``unswallow.check`` span plus a
``unswallow.detections`` counter. With neither passed it is a no-op.

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

from typing import Any, Optional

from ..types import SwallowCheckResult


def observe_check_result(
    result: SwallowCheckResult,
    tracer: Any = None,
    meter: Any = None,
) -> None:
    """Emit a span + detection counter for one check result, if available."""
    attrs = {
        "detected": bool(result.detected),
        "pattern": result.pattern or "none",
        "recovered": bool(result.recovered),
        "confidence": float(result.confidence),
        "engine": (result.matrix_match.engine if result.matrix_match else result.engine_hint) or "unknown",
    }
    if tracer is not None:
        span = tracer.start_span("unswallow.check")
        set_attrs = getattr(span, "set_attributes", None)
        if callable(set_attrs):
            set_attrs(attrs)
        span.end()
    if meter is not None:
        counter = meter.create_counter(
            "unswallow.detections",
            description="Tool calls recovered from the reasoning channel",
        )
        counter.add(1 if result.detected else 0, {"pattern": result.pattern or "none"})