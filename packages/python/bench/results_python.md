# unswallow — Python performance report

measured 2026-09-04T18:17:16Z · Python 3.14.6 · windows amd64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.22 / 0.24 / 0.27 ms | 0.219 ms | 4,567 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.22 / 0.24 / 0.29 ms | 0.223 ms | 4,477 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.23 / 0.25 / 0.27 ms | 0.229 ms | 4,362 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 0.45 / 0.58 / 0.76 ms | 0.473 ms | 2,114 ops/s | 0.20 KB |
| Pattern B — trailing text in content | 1.1 KB | 2000 | 0.21 / 0.24 / 0.34 ms | 0.221 ms | 4,521 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.17 / 0.18 / 0.20 ms | 0.169 ms | 5,904 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.14 / 0.16 / 0.19 ms | 0.145 ms | 6,879 ops/s | 0.01 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.15 / 0.17 / 0.19 ms | 0.154 ms | 6,503 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 839 | 19.7 KB | 13.39 / 13.94 / 14.34 ms | 13.439 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.36 / 0.47 / 0.59 ms | 0.376 ms | 2,659 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.04 / 0.04 ms | 0.008 ms | 119,202 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.025 ms | 39,284 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.010 ms | 102,663 ops/s |
| Pattern A — large reasoning (64KB) | 0.322 ms | 3,102 ops/s |
| Pattern A — 1MB reasoning | 4.550 ms | 219 ops/s |
| Pattern B — trailing text in content | 0.014 ms | 70,690 ops/s |
| Pattern C — field leak (detection-only) | 0.004 ms | 248,839 ops/s |
| Healthy — tool_calls already populated | 0.006 ms | 161,118 ops/s |
| False-positive guard — discussion-only | 0.008 ms | 123,001 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)
