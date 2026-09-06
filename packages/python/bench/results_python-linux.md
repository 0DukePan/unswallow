# unswallow — Python performance report

measured 2026-09-06T01:56:20Z · Python 3.13.15 · linux x86_64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the TypeScript report must carry the same hash (cross-language "same seeds, same payloads" check).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.14 / 0.17 / 0.18 ms | 0.147 ms (0.146–0.149) | 6,786 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.15 / 0.18 / 0.19 ms | 0.156 ms (0.155–0.157) | 6,413 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.15 / 0.17 / 0.19 ms | 0.150 ms (0.149–0.154) | 6,653 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.23 / 0.25 / 0.28 ms | 0.231 ms (0.227–0.233) | 4,329 ops/s | 0.18 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.14 / 0.17 / 0.18 ms | 0.144 ms (0.144–0.146) | 6,935 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.09 / 0.11 / 0.12 ms | 0.094 ms (0.094–0.094) | 10,630 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.06 / 0.08 / 0.09 ms | 0.066 ms (0.066–0.067) | 15,133 ops/s | 0.01 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.07 / 0.10 / 0.12 ms | 0.078 ms (0.077–0.079) | 12,890 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 7.67 / 8.07 / 8.19 ms | 7.687 ms (7.548–7.900) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (copy.deepcopy) | 987.4 KB | 600 | 0.008 ms (0.008–0.008) |
| envelope scan of 1 MB reasoning (extract_all_envelopes) | 976.7 KB | 900 | 0.064 ms (0.064–0.064) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 6.832 ms (6.585–7.017) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.32 / 0.34 / 0.35 ms | 0.313 ms (0.312–0.326) | 3,195 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.03 / 0.03 ms | 0.006 ms (0.006–0.006) | 155,361 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.031 ms (0.031–0.031) | 32,378 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.014 ms (0.014–0.014) | 70,188 ops/s |
| Pattern A — large reasoning (64KB) | 0.520 ms (0.520–0.522) | 1,922 ops/s |
| Pattern A — 1MB reasoning | 7.837 ms (7.791–8.150) | 127 ops/s |
| Pattern B — trailing text in content | 0.009 ms (0.009–0.009) | 110,498 ops/s |
| Pattern C — field leak (detection-only) | 0.004 ms (0.004–0.004) | 228,055 ops/s |
| Healthy — tool_calls already populated | 0.008 ms (0.008–0.008) | 128,314 ops/s |
| False-positive guard — discussion-only | 0.011 ms (0.011–0.011) | 89,504 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.162 ms (0.161–0.162) | 6,185 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.077 ms (0.076–0.078) | 13,021 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.103 ms (0.103–0.103) | 9,701 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.114 ms (0.113–0.132) | 8,801 ops/s |
| fp-guard-multiple-partial | no | 0.4 KB | 9000 | 0.101 ms (0.101–0.101) | 9,921 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.094 ms (0.094–0.095) | 10,625 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.089 ms (0.088–0.089) | 11,296 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.092 ms (0.092–0.093) | 10,843 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.175 ms (0.175–0.176) | 5,701 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.096 ms (0.096–0.096) | 10,425 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.4 KB | 600 | 0.129 ms (0.129–0.130) | 7,726 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.146 ms (0.145–0.147) | 6,834 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.189 ms (0.187–0.189) | 5,304 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.162 ms (0.161–0.162) | 6,190 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.190 ms (0.190–0.191) | 5,270 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.180 ms (0.178–0.180) | 5,561 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.204 ms (0.203–0.205) | 4,893 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.067 ms (0.067–0.067) | 14,956 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.205 ms (0.205–0.205) | 4,879 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.5 KB | 9000 | 0.216 ms (0.215–0.216) | 4,634 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.200 ms (0.200–0.202) | 4,993 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.8 KB | 600 | 0.288 ms (0.287–0.293) | 3,475 ops/s |
