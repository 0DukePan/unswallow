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
      name_known: String(attrs.name_known),
      schema_valid: String(attrs.schema_valid),
    };
    opts.meter.createCounter('swallowed_tool_calls_total', {
      description: 'Responses where a swallowed tool-call pattern was detected',
    }).add(result.detected ? 1 : 0, metricAttrs);
    opts.meter.createCounter('recovered_tool_calls_total', {
      description: 'Tool calls recovered from structurally valid envelopes',
    }).add(result.recovered ? (result.toolCalls?.length ?? 0) : 0, metricAttrs);
    const guardBlocked = result.detected && !result.recovered && result.pattern !== 'C';
    opts.meter.createCounter('false_positive_guard_total', {
      description: 'Detections withheld by a recovery safety gate',
    }).add(guardBlocked ? 1 : 0, metricAttrs);
    if (result.pattern) {
      opts.meter.createCounter(`pattern_${result.pattern.toLowerCase()}_total`, {
        description: `Detected Pattern ${result.pattern} responses`,
      }).add(result.detected ? 1 : 0, metricAttrs);
    }
    if (typeof opts.recoveryLatencyMs === 'number' && Number.isFinite(opts.recoveryLatencyMs) && opts.recoveryLatencyMs >= 0) {
      opts.meter.createHistogram?.('recovery_latency_ms', {
        description: 'Wall-clock time measured by the caller around check and recovery', unit: 'ms',
      }).record(opts.recoveryLatencyMs, metricAttrs);
    }
  }
}