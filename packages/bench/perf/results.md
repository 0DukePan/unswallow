# unswallow — performance report

measured 2026-09-03T02:55:53.751Z · v22.16.0 · win32 x64 · AMD Ryzen 5 2600X Six-Core Processor            (12 cores) · 15.9 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.15 / 0.24 / 0.46 ms | 0.162 ms | 6,159 ops/s | 0.03 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.13 / 0.21 / 0.41 ms | 0.141 ms | 7,100 ops/s | 0.03 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.23 / 0.37 / 0.74 ms | 0.248 ms | 4,027 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 2.29 / 4.82 / 9.03 ms | 2.721 ms | 367 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 2000 | 0.14 / 0.24 / 0.42 ms | 0.152 ms | 6,570 ops/s | 0.02 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.09 / 0.15 / 0.31 ms | 0.096 ms | 10,396 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.08 / 0.12 / 0.21 ms | 0.080 ms | 12,544 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.08 / 0.12 / 0.20 ms | 0.083 ms | 12,065 ops/s | 0.03 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 1.98 / 3.07 / 3.58 ms | 2.066 ms |
| 500 KB content stream | 5323 | 500.0 KB | 15.11 / 17.93 / 18.58 ms | 15.180 ms |
| reference: same message, non-streaming checkAndRescue | — | — | 0.17 / 0.29 / 0.61 ms | 0.186 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.09 / 0.13 / 0.24 ms | 0.091 ms | 11,021 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.01 / 0.01 ms | 0.002 ms | 519,049 ops/s |

## Reference point

| workload | mean |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.333 ms |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 2.67 ms | 5.88 ms | +3.22 ms |
| non-stream, healthy (passthrough) | 2.01 ms | 4.72 ms | +2.71 ms |
| streaming, swallowed (recovery tail) | 3.17 ms | 5.63 ms | +2.46 ms |
