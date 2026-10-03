import type { SwallowCheckResult } from '../types';

/**
 * Optional OpenTelemetry integration — the core stays zero-dependency.
 *
 * Nothing here imports `@opentelemetry/api`: pass the `tracer` / `meter` you
 * already have and this module emits a `unswallow.check` span plus
 * low-cardinality recovery counters. With no tracer/meter passed it is a no-op.
 *
 * ```ts
 * import { trace, metrics } from '@opentelemetry/api';
 * import { observeCheckResult } from 'unswallow';
 *
 * const result = checkAndRescue(response);
 * observeCheckResult(result, { tracer: trace.getTracer('app'), meter: metrics.getMeter('app') });
 * ```
 */

// Structural types so no OpenTelemetry dependency is required at build time.
export interface SpanLike {
  setAttribute?(key: string, value: unknown): void;
  setAttributes?(attrs: Record<string, unknown>): void;
  end(): void;
}

export interface TracerLike {
  startSpan(name: string, opts?: Record<string, unknown>): SpanLike;
}

export interface CounterLike {
  add(delta: number, attrs?: Record<string, unknown>): void;
}

export interface HistogramLike {
  record(value: number, attrs?: Record<string, unknown>): void;
}

export interface MeterLike {
  createCounter(name: string, opts?: Record<string, unknown>): CounterLike;
  createHistogram?(name: string, opts?: Record<string, unknown>): HistogramLike;
}

export interface ObservabilityOptions {
  tracer?: TracerLike;
  meter?: MeterLike;
  /** Measured by the caller around check/recovery, in milliseconds. */
  recoveryLatencyMs?: number;
  /** Optional caller-owned structured logging hook; no logging dependency is added. */
  onAuditLog?: (event: { type: 'unswallow.check'; result: SwallowCheckResult }) => void;
}

const instruments = new WeakMap<object, Map<string, unknown>>();
function cached<T>(meter: object, name: string, make: () => T): T {
  let byName = instruments.get(meter);
  if (!byName) instruments.set(meter, (byName = new Map()));
  if (!byName.has(name)) byName.set(name, make());
  return byName.get(name) as T;
}
function counter(meter: MeterLike, name: string, o: Record<string, unknown>): CounterLike {
  return cached(meter, name, () => meter.createCounter(name, o));
}
function histogram(meter: MeterLike, name: string, o: Record<string, unknown>): HistogramLike | undefined {
  return meter.createHistogram ? cached(meter, name, () => meter.createHistogram!(name, o)) : undefined;
}

export function observeCheckResult(
  result: SwallowCheckResult,
  opts: ObservabilityOptions = {}
): void {
  opts.onAuditLog?.({ type: 'unswallow.check', result });
  const attrs: Record<string, unknown> = {
    detected: result.detected,
    pattern: result.pattern ?? 'none',
    recovered: result.recovered,
    confidence: result.confidence,
    engine: result.matrixMatch?.engine ?? result.engineHint ?? 'unknown',
    name_known: result.validation?.nameKnown ?? 'unknown',
    schema_valid: result.validation?.schemaValid ?? 'unknown',
  };
  if (opts.tracer) {
    const span = opts.tracer.startSpan('unswallow.check');
    span.setAttributes?.(attrs);
    if (result.detected) span.setAttribute?.('warnings', result.warnings.length);
    span.end();
  }
  if (opts.meter) {
    const metricAttrs = {
      engine: String(attrs.engine),
      pattern: String(attrs.pattern),
      category: result.category ?? 'none',
      name_known: String(attrs.name_known),
      schema_valid: String(attrs.schema_valid),
    };
    counter(opts.meter, 'swallowed_tool_calls_total', {
      description: 'Responses where a swallowed tool-call pattern was detected',
    }).add(result.detected ? 1 : 0, metricAttrs);
    counter(opts.meter, 'recovered_tool_calls_total', {
      description: 'Tool calls recovered from structurally valid envelopes',
    }).add(result.recovered ? (result.recoveredCalls?.length ?? 0) : 0, metricAttrs);
    const guardBlocked = result.detected && !result.recovered && result.pattern !== 'C';
    counter(opts.meter, 'false_positive_guard_total', {
      description: 'Detections withheld by a recovery safety gate',
    }).add(guardBlocked ? 1 : 0, metricAttrs);
    const intentBlocked =
      result.detected && !result.recovered && (result.intent?.blocked.length ?? 0) > 0;
    counter(opts.meter, 'recovery_blocked_total', {
      description: 'Candidates withheld by the intent gate (per response)',
    }).add(intentBlocked ? 1 : 0, metricAttrs);
    if (result.pattern) {
      counter(opts.meter, `pattern_${result.pattern.toLowerCase()}_total`, {
        description: `Detected Pattern ${result.pattern} responses`,
      }).add(result.detected ? 1 : 0, metricAttrs);
    }
    if (typeof opts.recoveryLatencyMs === 'number' && Number.isFinite(opts.recoveryLatencyMs) && opts.recoveryLatencyMs >= 0) {
      histogram(opts.meter, 'recovery_latency_ms', {
        description: 'Wall-clock time measured by the caller around check and recovery', unit: 'ms',
      })?.record(opts.recoveryLatencyMs, metricAttrs);
    }
  }
}