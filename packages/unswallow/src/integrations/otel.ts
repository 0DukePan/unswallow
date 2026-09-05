import type { SwallowCheckResult } from '../types';

/**
 * Optional OpenTelemetry integration — the core stays zero-dependency.
 *
 * Nothing here imports `@opentelemetry/api`: pass the `tracer` / `meter` you
 * already have and this module emits a `unswallow.check` span plus a
 * `unswallow.detections` counter. With no tracer/meter passed it is a no-op.
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

export interface MeterLike {
  createCounter(name: string, opts?: Record<string, unknown>): CounterLike;
}

export interface ObservabilityOptions {
  tracer?: TracerLike;
  meter?: MeterLike;
}

export function observeCheckResult(
  result: SwallowCheckResult,
  opts: ObservabilityOptions = {}
): void {
  const attrs: Record<string, unknown> = {
    detected: result.detected,
    pattern: result.pattern ?? 'none',
    recovered: result.recovered,
    confidence: result.confidence,
    engine: result.matrixMatch?.engine ?? result.engineHint ?? 'unknown',
  };
  if (opts.tracer) {
    const span = opts.tracer.startSpan('unswallow.check');
    span.setAttributes?.(attrs);
    if (result.detected) span.setAttribute?.('warnings', result.warnings.length);
    span.end();
  }
  if (opts.meter) {
    const counter = opts.meter.createCounter('unswallow.detections', {
      description: 'Tool calls recovered from the reasoning channel',
    });
    counter.add(result.detected ? 1 : 0, {
      pattern: result.pattern ?? 'none',
    });
  }
}