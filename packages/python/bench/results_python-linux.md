# unswallow — Python performance report

measured 2026-09-09T01:38:01Z · Python 3.13.15 · linux x86_64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the TypeScript report must carry the same hash (cross-language "same seeds, same payloads" check).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.15 / 0.18 / 0.19 ms | 0.156 ms (0.155–0.157) | 6,414 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.16 / 0.19 / 0.23 ms | 0.166 ms (0.166–0.172) | 6,009 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.15 / 0.18 / 0.19 ms | 0.158 ms (0.158–0.159) | 6,324 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.24 / 0.26 / 0.28 ms | 0.242 ms (0.239–0.246) | 4,136 ops/s | 0.18 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.15 / 0.18 / 0.19 ms | 0.155 ms (0.155–0.157) | 6,458 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.10 / 0.12 / 0.19 ms | 0.105 ms (0.103–0.109) | 9,527 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.07 / 0.09 / 0.10 ms | 0.074 ms (0.073–0.074) | 13,589 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.08 / 0.10 / 0.12 ms | 0.084 ms (0.084–0.085) | 11,872 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 7.33 / 7.58 / 7.68 ms | 7.367 ms (7.247–7.407) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (copy.deepcopy) | 987.4 KB | 600 | 0.008 ms (0.008–0.008) |
| envelope scan of 1 MB reasoning (extract_all_envelopes) | 976.7 KB | 900 | 0.063 ms (0.062–0.066) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 6.915 ms (6.894–6.966) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.32 / 0.33 / 0.35 ms | 0.322 ms (0.317–0.322) | 3,109 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.03 / 0.03 ms | 0.007 ms (0.007–0.007) | 138,860 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.031 ms (0.031–0.031) | 32,577 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.014 ms (0.014–0.014) | 70,215 ops/s |
| Pattern A — large reasoning (64KB) | 0.519 ms (0.518–0.519) | 1,928 ops/s |
| Pattern A — 1MB reasoning | 8.161 ms (8.149–8.176) | 122 ops/s |
| Pattern B — trailing text in content | 0.009 ms (0.009–0.009) | 110,635 ops/s |
| Pattern C — field leak (detection-only) | 0.005 ms (0.005–0.005) | 211,955 ops/s |
| Healthy — tool_calls already populated | 0.009 ms (0.009–0.009) | 116,096 ops/s |
| False-positive guard — discussion-only | 0.012 ms (0.012–0.012) | 80,380 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.182 ms (0.181–0.187) | 5,502 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.085 ms (0.084–0.085) | 11,819 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.110 ms (0.110–0.110) | 9,106 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.121 ms (0.120–0.121) | 8,294 ops/s |
| fp-guard-multiple-partial | no | 0.4 KB | 9000 | 0.108 ms (0.107–0.109) | 9,298 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.101 ms (0.101–0.101) | 9,883 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.096 ms (0.095–0.096) | 10,459 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.099 ms (0.099–0.100) | 10,057 ops/s |
| llamacpp-b8461-qwen3.5-9b-multiturn-pattern-a | no | 0.4 KB | 9000 | 0.181 ms (0.180–0.182) | 5,531 ops/s |
| llamacpp-b8461-qwen3.5-9b-streaming-multiturn-pattern-a | yes | 3.6 KB | 600 | 0.526 ms (0.524–0.527) | 1,902 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.187 ms (0.187–0.188) | 5,334 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.105 ms (0.104–0.111) | 9,545 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.4 KB | 600 | 0.139 ms (0.139–0.140) | 7,195 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.157 ms (0.156–0.161) | 6,355 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.199 ms (0.198–0.199) | 5,024 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.182 ms (0.182–0.182) | 5,505 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.208 ms (0.203–0.208) | 4,799 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.192 ms (0.190–0.194) | 5,221 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.216 ms (0.214–0.218) | 4,635 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.075 ms (0.074–0.075) | 13,400 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.215 ms (0.215–0.216) | 4,643 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.5 KB | 9000 | 0.225 ms (0.224–0.226) | 4,439 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.211 ms (0.210–0.211) | 4,744 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.8 KB | 600 | 0.297 ms (0.296–0.297) | 3,372 ops/s |
