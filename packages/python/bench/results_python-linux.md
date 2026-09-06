# unswallow — Python performance report

measured 2026-09-06T02:07:38Z · Python 3.13.15 · linux x86_64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the TypeScript report must carry the same hash (cross-language "same seeds, same payloads" check).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.14 / 0.16 / 0.18 ms | 0.144 ms (0.144–0.145) | 6,925 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.15 / 0.17 / 0.19 ms | 0.154 ms (0.153–0.154) | 6,507 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.14 / 0.17 / 0.19 ms | 0.146 ms (0.145–0.153) | 6,834 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.22 / 0.24 / 0.25 ms | 0.219 ms (0.216–0.229) | 4,568 ops/s | 0.18 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.14 / 0.16 / 0.26 ms | 0.143 ms (0.141–0.157) | 7,005 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.09 / 0.11 / 0.12 ms | 0.092 ms (0.092–0.092) | 10,859 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.06 / 0.08 / 0.09 ms | 0.065 ms (0.065–0.066) | 15,293 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.07 / 0.09 / 0.10 ms | 0.075 ms (0.075–0.078) | 13,293 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 7.50 / 7.72 / 7.83 ms | 7.506 ms (7.429–7.585) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (copy.deepcopy) | 987.4 KB | 600 | 0.008 ms (0.008–0.008) |
| envelope scan of 1 MB reasoning (extract_all_envelopes) | 976.7 KB | 900 | 0.051 ms (0.050–0.055) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 7.285 ms (7.137–7.396) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.31 / 0.33 / 0.34 ms | 0.313 ms (0.305–0.320) | 3,191 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.03 / 0.03 ms | 0.006 ms (0.006–0.006) | 154,688 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.031 ms (0.031–0.031) | 32,624 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.014 ms (0.014–0.015) | 70,536 ops/s |
| Pattern A — large reasoning (64KB) | 0.518 ms (0.517–0.518) | 1,930 ops/s |
| Pattern A — 1MB reasoning | 8.155 ms (8.135–8.164) | 122 ops/s |
| Pattern B — trailing text in content | 0.009 ms (0.009–0.009) | 111,167 ops/s |
| Pattern C — field leak (detection-only) | 0.005 ms (0.005–0.005) | 214,056 ops/s |
| Healthy — tool_calls already populated | 0.009 ms (0.009–0.009) | 117,035 ops/s |
| False-positive guard — discussion-only | 0.012 ms (0.012–0.013) | 80,589 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.160 ms (0.159–0.160) | 6,267 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.076 ms (0.076–0.077) | 13,118 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.102 ms (0.102–0.102) | 9,830 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.112 ms (0.112–0.112) | 8,923 ops/s |
| fp-guard-multiple-partial | no | 0.4 KB | 9000 | 0.099 ms (0.098–0.099) | 10,121 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.092 ms (0.092–0.092) | 10,834 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.086 ms (0.086–0.086) | 11,594 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.091 ms (0.091–0.092) | 10,978 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.174 ms (0.174–0.175) | 5,731 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.094 ms (0.093–0.094) | 10,688 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.4 KB | 600 | 0.126 ms (0.126–0.128) | 7,916 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.143 ms (0.142–0.143) | 6,984 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.187 ms (0.185–0.189) | 5,346 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.160 ms (0.160–0.160) | 6,254 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.188 ms (0.187–0.189) | 5,319 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.175 ms (0.175–0.176) | 5,707 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.201 ms (0.201–0.202) | 4,974 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.066 ms (0.065–0.066) | 15,241 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.202 ms (0.202–0.202) | 4,940 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.5 KB | 9000 | 0.212 ms (0.212–0.212) | 4,718 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.197 ms (0.197–0.198) | 5,063 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.8 KB | 600 | 0.283 ms (0.281–0.284) | 3,527 ops/s |
