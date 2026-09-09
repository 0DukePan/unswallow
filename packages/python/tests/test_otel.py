import unittest

from unswallow.integrations.otel import observe_check_result
from unswallow.types import SwallowCheckResult, not_detected


class FakeSpan:
    def __init__(self):
        self.attrs = {}
        self.ended = False

    def set_attributes(self, attrs):
        self.attrs.update(attrs)

    def end(self):
        self.ended = True


class FakeTracer:
    def __init__(self):
        self.spans = []

    def start_span(self, name):
        span = FakeSpan()
        self.spans.append(span)
        return span


class FakeCounter:
    def __init__(self):
        self.calls = []

    def add(self, delta, attrs=None):
        self.calls.append((delta, attrs))


class FakeHistogram:
    def __init__(self):
        self.calls = []

    def record(self, value, attrs=None):
        self.calls.append((value, attrs))


class FakeMeter:
    def __init__(self):
        self.counters = []
        self.histograms = []

    def create_counter(self, name, description=None):
        counter = FakeCounter()
        self.counters.append((name, counter))
        return counter

    def create_histogram(self, name, description=None, unit=None):
        histogram = FakeHistogram()
        self.histograms.append((name, histogram))
        return histogram


def detected_result(**kw):
    base = SwallowCheckResult(
        detected=True,
        pattern="A",
        tool_call=None,
        tool_calls=None,
        recovered=True,
        source="thinking",
        engine_hint="vllm",
        matrix_match=None,
        confidence=0.95,
        warnings=[],
        recovered_response=None,
    )
    for k, v in kw.items():
        setattr(base, k, v)
    return base


class OTelTest(unittest.TestCase):
    def test_noop_without_tracer_meter(self):
        observe_check_result(not_detected("unknown"))

    def test_audit_callback_receives_result(self):
        result = detected_result()
        events = []
        observe_check_result(result, audit_log=events.append)
        self.assertEqual(events, [{"type": "unswallow.check", "result": result}])

    def test_tracer_receives_detection_attributes(self):
        tracer = FakeTracer()
        observe_check_result(detected_result(), tracer=tracer)
        self.assertEqual(len(tracer.spans), 1)
        attrs = tracer.spans[0].attrs
        self.assertTrue(attrs["detected"])
        self.assertEqual(attrs["pattern"], "A")
        self.assertEqual(attrs["confidence"], 0.95)
        self.assertTrue(tracer.spans[0].ended)

    def test_meter_records_recovery_metrics_and_latency(self):
        meter = FakeMeter()
        observe_check_result(detected_result(), meter=meter, recovery_latency_ms=12.5)
        counters = dict(meter.counters)
        self.assertEqual(counters["swallowed_tool_calls_total"].calls[0][0], 1)
        self.assertEqual(counters["recovered_tool_calls_total"].calls[0][0], 0)
        self.assertEqual(counters["false_positive_guard_total"].calls[0][0], 0)
        self.assertEqual(counters["pattern_a_total"].calls[0][0], 1)
        self.assertEqual(meter.histograms[0][0], "recovery_latency_ms")
        self.assertEqual(meter.histograms[0][1].calls[0][0], 12.5)

    def test_meter_records_guard_block(self):
        meter = FakeMeter()
        observe_check_result(detected_result(recovered=False), meter=meter)
        counters = dict(meter.counters)
        self.assertEqual(counters["false_positive_guard_total"].calls[0][0], 1)


if __name__ == "__main__":
    unittest.main()
