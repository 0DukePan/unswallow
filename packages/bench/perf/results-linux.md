# unswallow — performance report

measured 2026-09-06T02:06:07.921Z · v22.23.2 · linux x64 · AMD EPYC 7763 64-Core Processor (4 cores) · 15.6 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the Python report must carry the same hash (cross-language "same seeds, same payloads" check).

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.02 / 0.05 / 0.07 ms | 0.024 ms (0.021–0.040) | 42,330 ops/s | 0.01 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.02 / 0.03 / 0.05 ms | 0.021 ms (0.021–0.029) | 46,841 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.05 / 0.07 / 0.08 ms | 0.057 ms (0.055–0.057) | 17,635 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.99 / 2.22 / 2.28 ms | 1.073 ms (1.057–1.079) | 932 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.02 / 0.04 / 0.05 ms | 0.019 ms (0.019–0.030) | 51,959 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.01 / 0.02 / 0.03 ms | 0.011 ms (0.011–0.015) | 92,636 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.01 / 0.01 / 0.02 ms | 0.010 ms (0.010–0.011) | 101,357 ops/s | 0.01 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.01 / 0.02 / 0.02 ms | 0.010 ms (0.010–0.013) | 100,670 ops/s | 0.00 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.67 / 0.93 / 1.05 ms | 0.694 ms (0.687–0.695) |
| 500 KB content stream | 5323 | 500.0 KB | 5.93 / 6.42 / 6.51 ms | 6.038 ms (6.032–6.056) |
| reference: same message, non-streaming checkAndRescue | — | — | 0.03 / 0.05 / 0.07 ms | 0.033 ms (0.033–0.043) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (structuredClone) | 987.4 KB | 600 | 0.545 ms (0.544–0.548) |
| envelope scan of 1 MB reasoning (extractAllEnvelopes) | 976.7 KB | 900 | 0.427 ms (0.427–0.431) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 0.416 ms (0.415–0.416) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.04 / 0.05 / 0.10 ms | 0.045 ms (0.044–0.050) | 22,453 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.00 ms | 0.001 ms (0.001–0.001) | 1,418,004 ops/s |

## Reference point

| workload | mean (min–max) |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.238 ms (0.237–0.238) |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.75 ms | 3.48 ms | +1.73 ms |
| non-stream, healthy (passthrough) | 1.62 ms | 3.30 ms | +1.68 ms |
| streaming, swallowed (recovery tail) | 1.63 ms | 3.36 ms | +1.73 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.004 ms (0.003–0.007) | 251,532 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.001 ms (0.001–0.003) | 682,633 ops/s |
| Pattern A — large reasoning (64KB) | 0.051 ms (0.051–0.051) | 19,671 ops/s |
| Pattern A — 1MB reasoning | 1.246 ms (1.239–1.304) | 802 ops/s |
| Pattern B — trailing text in content | 0.001 ms (0.001–0.002) | 742,546 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms (0.001–0.001) | 824,827 ops/s |
| Healthy — tool_calls already populated | 0.001 ms (0.001–0.001) | 1,145,733 ops/s |
| False-positive guard — discussion-only | 0.001 ms (0.001–0.001) | 817,170 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.3 KB | 9000 | 0.026 ms (0.023–0.030) | 38,547 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.010 ms (0.010–0.011) | 98,240 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.013 ms (0.013–0.015) | 78,914 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.036 ms (0.035–0.036) | 28,126 ops/s |
| fp-guard-multiple-partial | no | 0.3 KB | 9000 | 0.012 ms (0.012–0.012) | 85,122 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.011 ms (0.011–0.011) | 91,165 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.011 ms (0.011–0.011) | 93,930 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.011 ms (0.011–0.013) | 87,989 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.025 ms (0.025–0.033) | 40,141 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.011 ms (0.011–0.012) | 93,231 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.3 KB | 600 | 0.028 ms (0.024–0.028) | 36,297 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.019 ms (0.019–0.023) | 51,363 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.047 ms (0.039–0.057) | 21,465 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.023 ms (0.022–0.026) | 44,428 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.029 ms (0.026–0.032) | 34,860 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.025 ms (0.025–0.026) | 40,541 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.027 ms (0.026–0.029) | 37,684 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.010 ms (0.009–0.010) | 104,675 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.031 ms (0.030–0.031) | 32,752 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.4 KB | 9000 | 0.034 ms (0.030–0.035) | 29,477 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.028 ms (0.027–0.030) | 35,533 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.7 KB | 600 | 0.060 ms (0.057–0.084) | 16,767 ops/s |
