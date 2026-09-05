# unswallow — Python performance report

measured 2026-09-05T01:41:03Z · Python 3.14.6 · windows amd64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the TypeScript report must carry the same hash (cross-language "same seeds, same payloads" check).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.33 / 0.55 / 0.89 ms | 0.360 ms (0.244–0.393) | 2,776 ops/s | 0.01 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.24 / 0.44 / 0.70 ms | 0.252 ms (0.245–0.365) | 3,962 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.36 / 0.65 / 1.02 ms | 0.400 ms (0.354–0.433) | 2,502 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.54 / 1.00 / 1.75 ms | 0.622 ms (0.456–0.799) | 1,607 ops/s | 0.19 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.22 / 0.32 / 0.44 ms | 0.236 ms (0.231–0.256) | 4,228 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.26 / 0.46 / 0.74 ms | 0.284 ms (0.260–0.297) | 3,524 ops/s | 0.02 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.21 / 0.35 / 0.56 ms | 0.228 ms (0.175–0.237) | 4,386 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.16 / 0.22 / 0.29 ms | 0.165 ms (0.158–0.173) | 6,074 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 18.11 / 24.58 / 27.55 ms | 18.225 ms (16.863–19.906) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (copy.deepcopy) | 987.4 KB | 600 | 0.014 ms (0.013–0.014) |
| envelope scan of 1 MB reasoning (extract_all_envelopes) | 976.7 KB | 900 | 0.321 ms (0.301–0.353) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 15.438 ms (15.169–18.757) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.44 / 0.84 / 1.20 ms | 0.540 ms (0.423–0.622) | 1,852 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.05 / 0.08 ms | 0.012 ms (0.011–0.013) | 81,563 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.028 ms (0.027–0.035) | 35,952 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.010 ms (0.010–0.010) | 102,603 ops/s |
| Pattern A — large reasoning (64KB) | 0.318 ms (0.305–0.333) | 3,139 ops/s |
| Pattern A — 1MB reasoning | 6.595 ms (4.749–7.942) | 151 ops/s |
| Pattern B — trailing text in content | 0.016 ms (0.015–0.017) | 64,514 ops/s |
| Pattern C — field leak (detection-only) | 0.004 ms (0.004–0.004) | 251,597 ops/s |
| Healthy — tool_calls already populated | 0.006 ms (0.006–0.006) | 159,661 ops/s |
| False-positive guard — discussion-only | 0.008 ms (0.008–0.011) | 119,832 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.253 ms (0.245–0.275) | 3,957 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.235 ms (0.230–0.239) | 4,262 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.284 ms (0.280–0.290) | 3,526 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.210 ms (0.210–0.287) | 4,763 ops/s |
| fp-guard-multiple-partial | no | 0.4 KB | 9000 | 0.201 ms (0.189–0.209) | 4,971 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.256 ms (0.190–0.283) | 3,910 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.226 ms (0.187–0.299) | 4,420 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.248 ms (0.200–0.295) | 4,040 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.391 ms (0.354–0.402) | 2,555 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.278 ms (0.270–0.329) | 3,596 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.4 KB | 600 | 0.373 ms (0.357–0.440) | 2,680 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.372 ms (0.333–0.402) | 2,685 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.475 ms (0.461–0.479) | 2,106 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.449 ms (0.427–0.475) | 2,227 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.396 ms (0.294–0.505) | 2,527 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.301 ms (0.285–0.311) | 3,321 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.413 ms (0.372–0.471) | 2,422 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.225 ms (0.216–0.242) | 4,448 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.428 ms (0.418–0.434) | 2,338 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.5 KB | 9000 | 0.304 ms (0.302–0.316) | 3,288 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.369 ms (0.350–0.394) | 2,708 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.8 KB | 600 | 0.648 ms (0.613–0.727) | 1,544 ops/s |
