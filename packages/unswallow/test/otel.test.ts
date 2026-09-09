import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeCheckResult, type SpanLike, type CounterLike } from '../src/integrations/otel';
import type { SwallowCheckResult } from '../src/types';

class FakeSpan implements SpanLike {
  attrs: Record<string, unknown> = {};
  ended = false;
  setAttributes(attrs: Record<string, unknown>): void {
    this.attrs = { ...this.attrs, ...attrs };
  }
  end(): void {
    this.ended = true;
  }
}

class FakeTracer {
  spans: FakeSpan[] = [];
  startSpan(): FakeSpan {
    const s = new FakeSpan();
    this.spans.push(s);
    return s;
  }
}

class FakeCounter implements CounterLike {
  calls: Array<{ delta: number; attrs?: Record<string, unknown> }> = [];
  add(delta: number, attrs?: Record<string, unknown>): void {
    this.calls.push({ delta, attrs });
  }
}

class FakeHistogram {
  calls: Array<{ value: number; attrs?: Record<string, unknown> }> = [];
  record(value: number, attrs?: Record<string, unknown>): void {
    this.calls.push({ value, attrs });
  }
}

class FakeMeter {
  counters: Array<{ name: string; counter: FakeCounter }> = [];
  histograms: Array<{ name: string; histogram: FakeHistogram }> = [];
  createCounter(name: string): FakeCounter {
    const counter = new FakeCounter();
    this.counters.push({ name, counter });
    return counter;
  }
  createHistogram(name: string): FakeHistogram {
    const histogram = new FakeHistogram();
    this.histograms.push({ name, histogram });
    return histogram;
  }
}

function result(partial: Partial<SwallowCheckResult>): SwallowCheckResult {
  return {
    detected: false,
    pattern: null,
    toolCall: null,
    toolCalls: null,
    recovered: false,
    source: 'content',
    engineHint: 'unknown',
    matrixMatch: null,
    confidence: 0,
    warnings: [],
    recoveredResponse: null,
    ...partial,
    validation: partial.validation ?? null,
  };
}

test('observeCheckResult is a no-op without tracer/meter', () => {
  assert.doesNotThrow(() => observeCheckResult(result({})));
});

test('audit callback receives the unmodified check result', () => {
  const check = result({ detected: true, pattern: 'A' });
  let event: unknown;
  observeCheckResult(check, { onAuditLog: (value) => { event = value; } });
  assert.deepEqual(event, { type: 'unswallow.check', result: check });
});

test('tracer receives a span with detection attributes', () => {
  const tracer = new FakeTracer();
  observeCheckResult(
    result({ detected: true, pattern: 'A', recovered: true, confidence: 0.95, engineHint: 'vllm' }),
    { tracer }
  );
  assert.equal(tracer.spans.length, 1);
  assert.equal(tracer.spans[0].attrs.detected, true);
  assert.equal(tracer.spans[0].attrs.pattern, 'A');
  assert.equal(tracer.spans[0].attrs.confidence, 0.95);
  assert.equal(tracer.spans[0].attrs.engine, 'vllm'); // falls back to engineHint without a matrix match
  assert.equal(tracer.spans[0].ended, true);
});

test('matrix match engine flows into span attributes', () => {
  const tracer = new FakeTracer();
  observeCheckResult(
    result({
      detected: true,
      matrixMatch: { engine: 'sglang', versionRange: '*', pattern: 'A', behavior: 'swallow', verified: false, knownBehavior: 'x', source: 'https://github.com/sgl-project/sglang/issues/30744' },
    }),
    { tracer }
  );
  assert.equal(tracer.spans[0].attrs.engine, 'sglang');
});

test('meter records recovery counters, pattern totals, and optional latency', () => {
  const meter = new FakeMeter();
  observeCheckResult(result({ detected: true, recovered: true, pattern: 'B', toolCalls: [{ name: 'search', arguments: {} }] }), {
    meter, recoveryLatencyMs: 12.5,
  });
  const counter = (name: string) => meter.counters.find((entry) => entry.name === name)!.counter;
  assert.equal(counter('swallowed_tool_calls_total').calls[0].delta, 1);
  assert.equal(counter('recovered_tool_calls_total').calls[0].delta, 1);
  assert.equal(counter('false_positive_guard_total').calls[0].delta, 0);
  assert.equal(counter('pattern_b_total').calls[0].delta, 1);
  assert.equal(meter.histograms[0].name, 'recovery_latency_ms');
  assert.equal(meter.histograms[0].histogram.calls[0].value, 12.5);
});

test('meter records the false-positive guard when a non-C detection is blocked', () => {
  const meter = new FakeMeter();
  observeCheckResult(result({ detected: true, recovered: false, pattern: 'A' }), { meter });
  const guard = meter.counters.find((entry) => entry.name === 'false_positive_guard_total')!.counter;
  assert.equal(guard.calls[0].delta, 1);
});