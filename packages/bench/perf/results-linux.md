# unswallow — performance report

measured 2026-09-04T19:10:20.638Z · v22.23.2 · linux x64 · AMD EPYC 7763 64-Core Processor (4 cores) · 15.6 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 3000 | 0.03 / 0.06 / 0.09 ms | 0.040 ms | 25,227 ops/s | 0.03 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 3000 | 0.03 / 0.05 / 0.07 ms | 0.030 ms | 33,476 ops/s | 0.00 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 500 | 0.06 / 0.08 / 0.10 ms | 0.061 ms | 16,304 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 100 | 1.00 / 2.27 / 2.31 ms | 1.084 ms | 922 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 2000 | 0.03 / 0.05 / 0.08 ms | 0.031 ms | 32,104 ops/s | 0.00 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 2000 | 0.01 / 0.03 / 0.05 ms | 0.018 ms | 56,092 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 2000 | 0.01 / 0.02 / 0.02 ms | 0.011 ms | 90,168 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 2000 | 0.01 / 0.02 / 0.04 ms | 0.014 ms | 73,319 ops/s | 0.00 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.65 / 0.70 / 0.92 ms | 0.661 ms |
| 500 KB content stream | 5323 | 500.0 KB | 5.83 / 6.31 / 6.38 ms | 5.941 ms |
| reference: same message, non-streaming checkAndRescue | — | — | 0.04 / 0.09 / 0.12 ms | 0.053 ms |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.05 / 0.08 / 0.10 ms | 0.050 ms | 20,137 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.01 ms | 0.001 ms | 964,529 ops/s |

## Reference point

| workload | mean |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.227 ms |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.96 ms | 3.72 ms | +1.76 ms |
| non-stream, healthy (passthrough) | 1.70 ms | 3.55 ms | +1.85 ms |
| streaming, swallowed (recovery tail) | 1.74 ms | 3.55 ms | +1.81 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.004 ms | 266,551 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.004 ms | 248,596 ops/s |
| Pattern A — large reasoning (64KB) | 0.064 ms | 15,523 ops/s |
| Pattern A — 1MB reasoning | 1.220 ms | 820 ops/s |
| Pattern B — trailing text in content | 0.002 ms | 586,858 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms | 706,242 ops/s |
| Healthy — tool_calls already populated | 0.001 ms | 1,099,360 ops/s |
| False-positive guard — discussion-only | 0.001 ms | 793,816 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)
