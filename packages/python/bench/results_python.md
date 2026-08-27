# unswallow — Python performance report

measured 2026-08-26T14:00:17Z · Python 3.14.6 · windows amd64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.20 / 0.29 / 0.37 ms | 0.210 ms | 4,769 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.20 / 0.24 / 0.30 ms | 0.202 ms | 4,941 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.21 / 0.22 / 0.24 ms | 0.209 ms | 4,785 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 0.45 / 0.58 / 0.71 ms | 0.469 ms | 2,132 ops/s | 0.19 KB |
| Pattern B — trailing text in content | 1.1 KB | 2000 | 0.20 / 0.27 / 0.39 ms | 0.213 ms | 4,700 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.16 / 0.23 / 0.36 ms | 0.174 ms | 5,748 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.14 / 0.17 / 0.25 ms | 0.144 ms | 6,936 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.16 / 0.23 / 0.38 ms | 0.166 ms | 6,024 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 839 | 19.7 KB | 13.27 / 17.25 / 21.03 ms | 13.826 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.36 / 0.44 / 0.51 ms | 0.372 ms | 2,689 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.04 / 0.05 ms | 0.009 ms | 107,876 ops/s |
