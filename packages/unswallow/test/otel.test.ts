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

class FakeMeter {
  counters: FakeCounter[] = [];
  createCounter(): FakeCounter {
    const c = new FakeCounter();
    this.counters.push(c);
    return c;
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
  };
}

test('observeCheckResult is a no-op without tracer/meter', () => {
  assert.doesNotThrow(() => observeCheckResult(result({})));
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

test('meter records one detection counter increment', () => {
  const meter = new FakeMeter();
  observeCheckResult(result({ detected: true, pattern: 'B' }), { meter });
  assert.equal(meter.counters.length, 1);
  assert.equal(meter.counters[0].calls[0].delta, 1);
  assert.deepEqual(meter.counters[0].calls[0].attrs, { pattern: 'B' });

  const clean = new FakeMeter();
  observeCheckResult(result({}), { meter: clean });
  assert.equal(clean.counters[0].calls[0].delta, 0);
});