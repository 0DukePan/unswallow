# unswallow — Python performance report

measured 2026-09-04T17:55:58Z · Python 3.14.6 · windows amd64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.21 / 0.25 / 0.31 ms | 0.218 ms | 4,594 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.22 / 0.26 / 0.36 ms | 0.226 ms | 4,432 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.22 / 0.25 / 0.26 ms | 0.226 ms | 4,431 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 0.45 / 0.59 / 0.64 ms | 0.464 ms | 2,154 ops/s | 0.19 KB |
| Pattern B — trailing text in content | 1.1 KB | 2000 | 0.21 / 0.24 / 0.31 ms | 0.216 ms | 4,632 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.16 / 0.18 / 0.21 ms | 0.168 ms | 5,966 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.14 / 0.16 / 0.23 ms | 0.143 ms | 6,984 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.15 / 0.17 / 0.28 ms | 0.153 ms | 6,537 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 839 | 19.7 KB | 13.27 / 13.78 / 14.32 ms | 13.310 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.36 / 0.45 / 0.86 ms | 0.383 ms | 2,612 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.04 / 0.05 ms | 0.009 ms | 112,444 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.025 ms | 39,486 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.010 ms | 104,503 ops/s |
| Pattern A — large reasoning (64KB) | 0.302 ms | 3,306 ops/s |
| Pattern A — 1MB reasoning | 4.639 ms | 215 ops/s |
| Pattern B — trailing text in content | 0.015 ms | 68,910 ops/s |
| Pattern C — field leak (detection-only) | 0.004 ms | 250,796 ops/s |
| Healthy — tool_calls already populated | 0.006 ms | 160,639 ops/s |
| False-positive guard — discussion-only | 0.008 ms | 120,109 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)
