# unswallow — performance report

measured 2026-08-26T14:04:48.888Z · v22.16.0 · win32 x64 · AMD Ryzen 5 2600X Six-Core Processor            (12 cores) · 15.9 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.10 / 0.12 / 0.17 ms | 0.104 ms | 9,591 ops/s | 0.01 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.09 / 0.11 / 0.18 ms | 0.093 ms | 10,697 ops/s | 0.02 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.14 / 0.18 / 0.20 ms | 0.147 ms | 6,816 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 1.29 / 2.84 / 3.04 ms | 1.428 ms | 700 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 2000 | 0.08 / 0.10 / 0.14 ms | 0.088 ms | 11,348 ops/s | 0.03 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.06 / 0.07 / 0.10 ms | 0.060 ms | 16,533 ops/s | 0.04 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.04 / 0.05 / 0.08 ms | 0.046 ms | 21,752 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.06 / 0.07 / 0.09 ms | 0.060 ms | 16,607 ops/s | 0.03 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.86 / 1.34 / 1.63 ms | 0.941 ms |
| 500 KB content stream | 5323 | 500.0 KB | 10.02 / 10.73 / 10.90 ms | 10.025 ms |
| reference: same message, non-streaming checkAndRescue | — | — | 0.12 / 0.17 / 0.33 ms | 0.129 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.05 / 0.08 / 0.11 ms | 0.059 ms | 16,959 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.01 ms | 0.001 ms | 889,749 ops/s |

## Reference point

| workload | mean |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.244 ms |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.02 ms | 2.07 ms | +1.05 ms |
| non-stream, healthy (passthrough) | 0.75 ms | 1.81 ms | +1.06 ms |
| streaming, swallowed (recovery tail) | 0.84 ms | 1.93 ms | +1.10 ms |
