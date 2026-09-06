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


class FakeMeter:
    def __init__(self):
        self.counters = []

    def create_counter(self, name, description=None):
        counter = FakeCounter()
        self.counters.append(counter)
        return counter


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

    def test_tracer_receives_detection_attributes(self):
        tracer = FakeTracer()
        observe_check_result(detected_result(), tracer=tracer)
        self.assertEqual(len(tracer.spans), 1)
        attrs = tracer.spans[0].attrs
        self.assertTrue(attrs["detected"])
        self.assertEqual(attrs["pattern"], "A")
        self.assertEqual(attrs["confidence"], 0.95)
        self.assertTrue(tracer.spans[0].ended)

    def test_meter_counts_detection(self):
        meter = FakeMeter()
        observe_check_result(detected_result(), meter=meter)
        self.assertEqual(len(meter.counters), 1)
        delta, attrs = meter.counters[0].calls[0]
        self.assertEqual(delta, 1)
        self.assertEqual(attrs, {"pattern": "A"})

        clean = FakeMeter()
        observe_check_result(not_detected("unknown"), meter=clean)
        self.assertEqual(clean.counters[0].calls[0][0], 0)


if __name__ == "__main__":
    unittest.main()
