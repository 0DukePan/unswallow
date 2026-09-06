# unswallow — Python performance report

measured 2026-09-06T01:24:08Z · Python 3.13.15 · linux x86_64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the TypeScript report must carry the same hash (cross-language "same seeds, same payloads" check).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.07 / 0.08 / 0.08 ms | 0.068 ms (0.067–0.068) | 14,797 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.07 / 0.09 / 0.13 ms | 0.073 ms (0.073–0.088) | 13,614 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.07 / 0.09 / 0.09 ms | 0.071 ms (0.070–0.071) | 14,119 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.14 / 0.16 / 0.18 ms | 0.141 ms (0.140–0.144) | 7,075 ops/s | 0.18 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.07 / 0.08 / 0.08 ms | 0.066 ms (0.066–0.067) | 15,059 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.04 / 0.05 / 0.05 ms | 0.041 ms (0.041–0.042) | 24,539 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.03 / 0.03 / 0.04 ms | 0.031 ms (0.031–0.031) | 32,437 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.03 / 0.04 / 0.05 ms | 0.034 ms (0.034–0.035) | 29,448 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 4.90 / 5.49 / 6.37 ms | 4.904 ms (4.903–5.092) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (copy.deepcopy) | 987.4 KB | 600 | 0.005 ms (0.005–0.005) |
| envelope scan of 1 MB reasoning (extract_all_envelopes) | 976.7 KB | 900 | 0.029 ms (0.029–0.029) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 4.612 ms (4.611–4.618) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.18 / 0.20 / 0.21 ms | 0.177 ms (0.177–0.188) | 5,651 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.02 / 0.02 ms | 0.004 ms (0.004–0.004) | 267,232 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.012 ms (0.012–0.012) | 81,160 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.005 ms (0.005–0.005) | 217,201 ops/s |
| Pattern A — large reasoning (64KB) | 0.148 ms (0.148–0.148) | 6,771 ops/s |
| Pattern A — 1MB reasoning | 2.289 ms (2.268–2.329) | 436 ops/s |
| Pattern B — trailing text in content | 0.006 ms (0.006–0.006) | 165,451 ops/s |
| Pattern C — field leak (detection-only) | 0.002 ms (0.002–0.002) | 523,330 ops/s |
| Healthy — tool_calls already populated | 0.003 ms (0.003–0.003) | 334,029 ops/s |
| False-positive guard — discussion-only | 0.004 ms (0.004–0.004) | 244,481 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.076 ms (0.076–0.076) | 13,190 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.034 ms (0.034–0.034) | 29,507 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.048 ms (0.047–0.048) | 21,037 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.052 ms (0.052–0.052) | 19,246 ops/s |
| fp-guard-multiple-partial | no | 0.4 KB | 9000 | 0.047 ms (0.047–0.048) | 21,085 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.044 ms (0.044–0.044) | 22,820 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.037 ms (0.037–0.037) | 26,796 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.041 ms (0.041–0.041) | 24,598 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.083 ms (0.083–0.083) | 12,073 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.042 ms (0.041–0.043) | 24,059 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.4 KB | 600 | 0.064 ms (0.061–0.066) | 15,701 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.077 ms (0.074–0.080) | 12,911 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.105 ms (0.105–0.106) | 9,486 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.084 ms (0.083–0.085) | 11,901 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.102 ms (0.102–0.107) | 9,809 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.094 ms (0.094–0.095) | 10,664 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.106 ms (0.103–0.114) | 9,478 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.034 ms (0.031–0.036) | 29,357 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.101 ms (0.101–0.102) | 9,861 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.5 KB | 9000 | 0.106 ms (0.106–0.106) | 9,426 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.099 ms (0.097–0.100) | 10,113 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.8 KB | 600 | 0.149 ms (0.149–0.150) | 6,711 ops/s |
