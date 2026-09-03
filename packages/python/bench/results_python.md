# unswallow — Python performance report

measured 2026-09-03T02:44:36Z · Python 3.14.6 · windows amd64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.37 / 1.24 / 2.53 ms | 0.511 ms | 1,958 ops/s | 0.01 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.27 / 0.44 / 0.77 ms | 0.302 ms | 3,306 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.46 / 1.33 / 1.90 ms | 0.588 ms | 1,699 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 1.46 / 3.38 / 4.17 ms | 1.726 ms | 579 ops/s | 0.19 KB |
| Pattern B — trailing text in content | 1.1 KB | 2000 | 0.40 / 1.18 / 2.00 ms | 0.523 ms | 1,910 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.30 / 0.87 / 1.79 ms | 0.406 ms | 2,463 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.26 / 0.79 / 1.82 ms | 0.356 ms | 2,807 ops/s | 0.01 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.27 / 0.72 / 1.14 ms | 0.337 ms | 2,965 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 839 | 19.7 KB | 25.91 / 32.51 / 36.08 ms | 25.985 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.54 / 1.10 / 2.19 ms | 0.620 ms | 1,614 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.06 / 0.11 ms | 0.016 ms | 64,402 ops/s |
