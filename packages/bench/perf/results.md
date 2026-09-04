# unswallow — performance report

measured 2026-09-04T18:16:42.523Z · v22.16.0 · win32 x64 · AMD Ryzen 5 2600X Six-Core Processor            (12 cores) · 15.9 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.10 / 0.13 / 0.20 ms | 0.108 ms | 9,258 ops/s | 0.03 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.09 / 0.12 / 0.16 ms | 0.093 ms | 10,783 ops/s | 0.03 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.13 / 0.15 / 0.19 ms | 0.132 ms | 7,585 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 1.52 / 3.08 / 4.55 ms | 1.664 ms | 601 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 2000 | 0.09 / 0.11 / 0.16 ms | 0.093 ms | 10,775 ops/s | 0.03 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.06 / 0.09 / 0.11 ms | 0.061 ms | 16,381 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.05 / 0.06 / 0.08 ms | 0.048 ms | 20,723 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.05 / 0.07 / 0.09 ms | 0.052 ms | 19,210 ops/s | 0.03 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.91 / 1.28 / 1.59 ms | 0.946 ms |
| 500 KB content stream | 5323 | 500.0 KB | 7.46 / 8.30 / 8.75 ms | 7.640 ms |
| reference: same message, non-streaming checkAndRescue | — | — | 0.12 / 0.18 / 0.36 ms | 0.127 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.05 / 0.08 / 0.09 ms | 0.058 ms | 17,188 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.01 ms | 0.001 ms | 701,595 ops/s |

## Reference point

| workload | mean |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.236 ms |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.20 ms | 2.94 ms | +1.74 ms |
| non-stream, healthy (passthrough) | 0.85 ms | 2.11 ms | +1.26 ms |
| streaming, swallowed (recovery tail) | 0.98 ms | 2.82 ms | +1.84 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.005 ms | 207,215 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.004 ms | 285,059 ops/s |
| Pattern A — large reasoning (64KB) | 0.064 ms | 15,638 ops/s |
| Pattern A — 1MB reasoning | 1.218 ms | 821 ops/s |
| Pattern B — trailing text in content | 0.002 ms | 410,998 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms | 680,550 ops/s |
| Healthy — tool_calls already populated | 0.001 ms | 803,213 ops/s |
| False-positive guard — discussion-only | 0.001 ms | 783,668 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)
