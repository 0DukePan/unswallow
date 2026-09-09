# unswallow — performance report

measured 2026-09-09T01:36:24.399Z · v22.23.2 · linux x64 · AMD EPYC 7763 64-Core Processor (4 cores) · 15.6 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the Python report must carry the same hash (cross-language "same seeds, same payloads" check).

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.01 / 0.03 / 0.05 ms | 0.013 ms (0.010–0.025) | 76,530 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.01 / 0.02 / 0.03 ms | 0.011 ms (0.010–0.017) | 92,584 ops/s | 0.00 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.04 / 0.06 / 0.07 ms | 0.043 ms (0.043–0.047) | 23,267 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.97 / 2.18 / 2.22 ms | 1.043 ms (1.039–1.053) | 959 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.01 / 0.03 / 0.04 ms | 0.011 ms (0.008–0.018) | 89,499 ops/s | 0.00 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.00 / 0.01 / 0.01 ms | 0.005 ms (0.004–0.007) | 193,184 ops/s | 0.00 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.00 / 0.00 / 0.00 ms | 0.001 ms (0.001–0.002) | 928,356 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.00 / 0.00 / 0.00 ms | 0.002 ms (0.001–0.002) | 649,339 ops/s | 0.05 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.63 / 0.72 / 0.92 ms | 0.643 ms (0.642–0.644) |
| 500 KB content stream | 5323 | 500.0 KB | 5.79 / 6.15 / 6.25 ms | 5.877 ms (5.867–5.881) |
| reference: same message, non-streaming checkAndRescue | — | — | 0.02 / 0.02 / 0.04 ms | 0.019 ms (0.018–0.022) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (structuredClone) | 987.4 KB | 600 | 0.507 ms (0.505–0.511) |
| envelope scan of 1 MB reasoning (extractAllEnvelopes) | 976.7 KB | 900 | 0.435 ms (0.434–0.438) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 0.414 ms (0.414–0.416) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.04 / 0.05 / 0.06 ms | 0.045 ms (0.045–0.046) | 22,353 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.00 ms | 0.001 ms (0.001–0.001) | 1,456,487 ops/s |

## Reference point

| workload | mean (min–max) |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.224 ms (0.224–0.226) |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.80 ms | 3.56 ms | +1.76 ms |
| non-stream, healthy (passthrough) | 1.66 ms | 3.24 ms | +1.59 ms |
| streaming, swallowed (recovery tail) | 1.61 ms | 3.32 ms | +1.71 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.004 ms (0.003–0.005) | 255,457 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.001 ms (0.001–0.003) | 677,691 ops/s |
| Pattern A — large reasoning (64KB) | 0.050 ms (0.049–0.050) | 20,088 ops/s |
| Pattern A — 1MB reasoning | 1.214 ms (1.205–1.265) | 824 ops/s |
| Pattern B — trailing text in content | 0.001 ms (0.001–0.001) | 749,208 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms (0.001–0.001) | 851,470 ops/s |
| Healthy — tool_calls already populated | 0.001 ms (0.001–0.001) | 1,157,225 ops/s |
| False-positive guard — discussion-only | 0.001 ms (0.001–0.001) | 825,069 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.3 KB | 9000 | 0.014 ms (0.012–0.019) | 69,398 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.001 ms (0.001–0.001) | 984,532 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.003 ms (0.003–0.005) | 305,448 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.023 ms (0.023–0.024) | 42,601 ops/s |
| fp-guard-multiple-partial | no | 0.3 KB | 9000 | 0.003 ms (0.003–0.004) | 369,038 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.002 ms (0.002–0.002) | 525,675 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.002 ms (0.002–0.002) | 634,669 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.002 ms (0.002–0.004) | 446,836 ops/s |
| llamacpp-b8461-qwen3.5-9b-multiturn-pattern-a | no | 0.4 KB | 9000 | 0.012 ms (0.010–0.017) | 82,284 ops/s |
| llamacpp-b8461-qwen3.5-9b-streaming-multiturn-pattern-a | yes | 3.3 KB | 600 | 0.073 ms (0.064–0.089) | 13,650 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.013 ms (0.012–0.017) | 75,426 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.004 ms (0.002–0.004) | 283,646 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.3 KB | 600 | 0.018 ms (0.014–0.020) | 56,583 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.008 ms (0.008–0.010) | 120,400 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.030 ms (0.025–0.043) | 33,439 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.010 ms (0.010–0.013) | 95,911 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.013 ms (0.013–0.017) | 77,996 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.012 ms (0.012–0.013) | 84,761 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.013 ms (0.013–0.018) | 74,251 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.001 ms (0.001–0.001) | 1,946,665 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.018 ms (0.015–0.018) | 55,643 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.4 KB | 9000 | 0.019 ms (0.017–0.021) | 52,580 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.014 ms (0.014–0.015) | 72,314 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.7 KB | 600 | 0.044 ms (0.042–0.054) | 22,581 ops/s |
