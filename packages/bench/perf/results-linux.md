# unswallow — performance report

measured 2026-09-06T01:23:16.758Z · v22.23.2 · linux x64 · Intel(R) Xeon(R) 6973P-C (4 cores) · 15.6 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the Python report must carry the same hash (cross-language "same seeds, same payloads" check).

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.01 / 0.02 / 0.03 ms | 0.011 ms (0.010–0.019) | 90,480 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.01 / 0.02 / 0.03 ms | 0.011 ms (0.010–0.015) | 90,621 ops/s | 0.03 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.03 / 0.05 / 0.06 ms | 0.036 ms (0.036–0.036) | 27,902 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.76 / 1.34 / 1.38 ms | 0.792 ms (0.786–0.806) | 1,262 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.01 / 0.01 / 0.02 ms | 0.009 ms (0.009–0.013) | 111,355 ops/s | 0.00 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.00 / 0.01 / 0.01 ms | 0.005 ms (0.005–0.008) | 183,002 ops/s | 0.00 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.00 / 0.01 / 0.01 ms | 0.004 ms (0.004–0.005) | 238,628 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.00 / 0.00 / 0.01 ms | 0.004 ms (0.004–0.005) | 228,380 ops/s | 0.00 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.40 / 0.60 / 0.66 ms | 0.413 ms (0.413–0.429) |
| 500 KB content stream | 5323 | 500.0 KB | 3.21 / 3.58 / 3.77 ms | 3.305 ms (3.301–3.313) |
| reference: same message, non-streaming checkAndRescue | — | — | 0.01 / 0.02 / 0.03 ms | 0.014 ms (0.014–0.018) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (structuredClone) | 987.4 KB | 600 | 0.343 ms (0.341–0.355) |
| envelope scan of 1 MB reasoning (extractAllEnvelopes) | 976.7 KB | 900 | 0.349 ms (0.349–0.352) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 0.247 ms (0.231–0.256) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.02 / 0.03 / 0.04 ms | 0.025 ms (0.024–0.028) | 40,744 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.00 ms | 0.000 ms (0.000–0.000) | 2,371,697 ops/s |

## Reference point

| workload | mean (min–max) |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.152 ms (0.152–0.154) |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.58 ms | 3.19 ms | +1.61 ms |
| non-stream, healthy (passthrough) | 1.50 ms | 3.00 ms | +1.50 ms |
| streaming, swallowed (recovery tail) | 1.51 ms | 3.06 ms | +1.56 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.003 ms (0.002–0.003) | 380,224 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.001 ms (0.001–0.001) | 993,697 ops/s |
| Pattern A — large reasoning (64KB) | 0.032 ms (0.032–0.032) | 31,040 ops/s |
| Pattern A — 1MB reasoning | 0.784 ms (0.764–0.952) | 1,275 ops/s |
| Pattern B — trailing text in content | 0.001 ms (0.001–0.001) | 1,143,853 ops/s |
| Pattern C — field leak (detection-only) | 0.000 ms (0.000–0.000) | 2,877,942 ops/s |
| Healthy — tool_calls already populated | 0.001 ms (0.001–0.001) | 1,635,461 ops/s |
| False-positive guard — discussion-only | 0.001 ms (0.001–0.001) | 1,084,865 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.3 KB | 9000 | 0.011 ms (0.010–0.012) | 92,259 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.004 ms (0.004–0.004) | 242,004 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.006 ms (0.006–0.006) | 180,856 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.019 ms (0.018–0.019) | 54,028 ops/s |
| fp-guard-multiple-partial | no | 0.3 KB | 9000 | 0.005 ms (0.005–0.006) | 195,996 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.005 ms (0.005–0.005) | 216,878 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.004 ms (0.004–0.004) | 225,993 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.005 ms (0.005–0.006) | 206,584 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.010 ms (0.010–0.013) | 98,327 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.005 ms (0.004–0.005) | 218,916 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.3 KB | 600 | 0.011 ms (0.010–0.012) | 92,025 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.009 ms (0.008–0.009) | 116,067 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.019 ms (0.015–0.022) | 52,009 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.009 ms (0.009–0.010) | 108,123 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.013 ms (0.011–0.014) | 79,744 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.010 ms (0.010–0.010) | 99,507 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.011 ms (0.011–0.012) | 91,307 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.004 ms (0.004–0.004) | 263,807 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.013 ms (0.012–0.013) | 78,588 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.4 KB | 9000 | 0.014 ms (0.014–0.014) | 71,256 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.013 ms (0.013–0.015) | 75,009 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.7 KB | 600 | 0.029 ms (0.026–0.035) | 33,900 ops/s |
