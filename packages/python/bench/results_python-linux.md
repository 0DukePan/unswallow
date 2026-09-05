# unswallow — Python performance report

measured 2026-09-05T03:25:55Z · Python 3.13.15 · linux x86_64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the TypeScript report must carry the same hash (cross-language "same seeds, same payloads" check).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.11 / 0.12 / 0.14 ms | 0.108 ms (0.108–0.109) | 9,252 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.11 / 0.13 / 0.15 ms | 0.115 ms (0.115–0.116) | 8,677 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.11 / 0.13 / 0.13 ms | 0.110 ms (0.110–0.111) | 9,052 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.17 / 0.21 / 0.34 ms | 0.178 ms (0.175–0.204) | 5,626 ops/s | 0.18 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.10 / 0.12 / 0.13 ms | 0.107 ms (0.106–0.108) | 9,331 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.07 / 0.08 / 0.09 ms | 0.071 ms (0.071–0.072) | 14,045 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.06 / 0.07 / 0.07 ms | 0.058 ms (0.058–0.058) | 17,144 ops/s | 0.01 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.06 / 0.07 / 0.08 ms | 0.063 ms (0.063–0.063) | 15,872 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 8.12 / 8.28 / 8.55 ms | 8.119 ms (8.114–8.151) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (copy.deepcopy) | 987.4 KB | 600 | 0.008 ms (0.008–0.008) |
| envelope scan of 1 MB reasoning (extract_all_envelopes) | 976.7 KB | 900 | 0.053 ms (0.053–0.053) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 7.535 ms (7.530–7.657) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.31 / 0.33 / 0.36 ms | 0.314 ms (0.313–0.317) | 3,182 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.03 / 0.03 ms | 0.006 ms (0.006–0.006) | 159,129 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.029 ms (0.029–0.030) | 33,995 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.013 ms (0.013–0.013) | 76,428 ops/s |
| Pattern A — large reasoning (64KB) | 0.471 ms (0.467–0.472) | 2,125 ops/s |
| Pattern A — 1MB reasoning | 6.775 ms (6.775–6.903) | 147 ops/s |
| Pattern B — trailing text in content | 0.010 ms (0.009–0.010) | 104,627 ops/s |
| Pattern C — field leak (detection-only) | 0.004 ms (0.004–0.004) | 223,946 ops/s |
| Healthy — tool_calls already populated | 0.008 ms (0.008–0.008) | 125,906 ops/s |
| False-positive guard — discussion-only | 0.011 ms (0.011–0.011) | 87,484 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.120 ms (0.120–0.120) | 8,351 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.064 ms (0.064–0.065) | 15,538 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.080 ms (0.080–0.080) | 12,501 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.087 ms (0.087–0.088) | 11,539 ops/s |
| fp-guard-multiple-partial | no | 0.4 KB | 9000 | 0.082 ms (0.082–0.082) | 12,183 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.076 ms (0.076–0.077) | 13,073 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.069 ms (0.069–0.069) | 14,499 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.072 ms (0.072–0.072) | 13,811 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.133 ms (0.133–0.133) | 7,521 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.072 ms (0.072–0.073) | 13,938 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.4 KB | 600 | 0.098 ms (0.097–0.099) | 10,179 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.107 ms (0.107–0.108) | 9,352 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.153 ms (0.153–0.154) | 6,515 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.119 ms (0.119–0.119) | 8,395 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.146 ms (0.146–0.146) | 6,853 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.135 ms (0.134–0.135) | 7,421 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.158 ms (0.157–0.170) | 6,341 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.062 ms (0.059–0.062) | 16,233 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.159 ms (0.159–0.159) | 6,278 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.5 KB | 9000 | 0.166 ms (0.166–0.166) | 6,028 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.153 ms (0.153–0.158) | 6,516 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.8 KB | 600 | 0.264 ms (0.246–0.273) | 3,785 ops/s |
