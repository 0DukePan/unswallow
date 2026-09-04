# unswallow — Python performance report

measured 2026-09-04T19:10:47Z · Python 3.13.15 · linux x86_64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.13 / 0.16 / 0.18 ms | 0.139 ms | 7,181 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.14 / 0.17 / 0.18 ms | 0.147 ms | 6,818 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.14 / 0.16 / 0.17 ms | 0.141 ms | 7,098 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 0.23 / 0.25 / 0.27 ms | 0.231 ms | 4,334 ops/s | 0.18 KB |
| Pattern B — trailing text in content | 1.1 KB | 2000 | 0.13 / 0.16 / 0.18 ms | 0.137 ms | 7,294 ops/s | 0.02 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.09 / 0.11 / 0.11 ms | 0.088 ms | 11,391 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.06 / 0.08 / 0.08 ms | 0.061 ms | 16,377 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.07 / 0.09 / 0.09 ms | 0.071 ms | 14,130 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 839 | 19.7 KB | 7.61 / 7.75 / 7.88 ms | 7.599 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.31 / 0.32 / 0.35 ms | 0.314 ms | 3,185 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.03 / 0.03 ms | 0.006 ms | 154,092 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.030 ms | 32,910 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.014 ms | 70,333 ops/s |
| Pattern A — large reasoning (64KB) | 0.514 ms | 1,945 ops/s |
| Pattern A — 1MB reasoning | 7.885 ms | 126 ops/s |
| Pattern B — trailing text in content | 0.009 ms | 110,805 ops/s |
| Pattern C — field leak (detection-only) | 0.005 ms | 213,561 ops/s |
| Healthy — tool_calls already populated | 0.009 ms | 116,788 ops/s |
| False-positive guard — discussion-only | 0.012 ms | 80,431 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)
