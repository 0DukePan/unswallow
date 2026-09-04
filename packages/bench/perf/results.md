# unswallow — performance report

measured 2026-09-04T17:55:12.586Z · v22.16.0 · win32 x64 · AMD Ryzen 5 2600X Six-Core Processor            (12 cores) · 15.9 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.11 / 0.16 / 0.25 ms | 0.115 ms | 8,706 ops/s | 0.03 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.09 / 0.11 / 0.16 ms | 0.092 ms | 10,898 ops/s | 0.03 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.13 / 0.15 / 0.18 ms | 0.130 ms | 7,683 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 1.24 / 3.01 / 3.41 ms | 1.358 ms | 736 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 2000 | 0.09 / 0.13 / 0.19 ms | 0.094 ms | 10,686 ops/s | 0.02 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.06 / 0.09 / 0.14 ms | 0.063 ms | 15,797 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.05 / 0.08 / 0.10 ms | 0.053 ms | 19,003 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.05 / 0.06 / 0.12 ms | 0.055 ms | 18,226 ops/s | 0.03 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.90 / 1.30 / 1.65 ms | 0.946 ms |
| 500 KB content stream | 5323 | 500.0 KB | 7.65 / 8.53 / 8.68 ms | 7.687 ms |
| reference: same message, non-streaming checkAndRescue | — | — | 0.11 / 0.17 / 0.33 ms | 0.122 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.05 / 0.07 / 0.10 ms | 0.057 ms | 17,524 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.01 ms | 0.001 ms | 718,612 ops/s |

## Reference point

| workload | mean |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.234 ms |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.27 ms | 2.74 ms | +1.47 ms |
| non-stream, healthy (passthrough) | 0.91 ms | 2.00 ms | +1.09 ms |
| streaming, swallowed (recovery tail) | 0.93 ms | 2.53 ms | +1.59 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.005 ms | 210,644 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.003 ms | 393,972 ops/s |
| Pattern A — large reasoning (64KB) | 0.062 ms | 16,127 ops/s |
| Pattern A — 1MB reasoning | 1.216 ms | 822 ops/s |
| Pattern B — trailing text in content | 0.002 ms | 412,133 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms | 1,012,658 ops/s |
| Healthy — tool_calls already populated | 0.001 ms | 737,083 ops/s |
| False-positive guard — discussion-only | 0.001 ms | 700,697 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)
