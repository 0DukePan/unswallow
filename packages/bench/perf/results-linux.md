# unswallow — performance report

measured 2026-09-05T03:24:33.735Z · v22.23.2 · linux x64 · AMD EPYC 9V74 80-Core Processor (4 cores) · 15.6 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the Python report must carry the same hash (cross-language "same seeds, same payloads" check).

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.02 / 0.04 / 0.05 ms | 0.020 ms (0.019–0.032) | 50,115 ops/s | 0.01 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.02 / 0.03 / 0.04 ms | 0.020 ms (0.019–0.025) | 51,117 ops/s | 0.02 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.06 / 0.07 / 0.08 ms | 0.061 ms (0.061–0.062) | 16,310 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 1.16 / 2.52 / 2.69 ms | 1.253 ms (1.236–1.260) | 798 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.02 / 0.02 / 0.03 ms | 0.018 ms (0.018–0.022) | 54,133 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.01 / 0.02 / 0.02 ms | 0.012 ms (0.012–0.016) | 83,696 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.01 / 0.01 / 0.02 ms | 0.011 ms (0.011–0.012) | 90,510 ops/s | 0.01 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.01 / 0.02 / 0.02 ms | 0.011 ms (0.011–0.013) | 90,357 ops/s | 0.00 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.68 / 0.93 / 1.03 ms | 0.699 ms (0.699–0.706) |
| 500 KB content stream | 5323 | 500.0 KB | 6.28 / 6.82 / 7.13 ms | 6.396 ms (6.394–6.474) |
| reference: same message, non-streaming checkAndRescue | — | — | 0.03 / 0.04 / 0.05 ms | 0.030 ms (0.028–0.032) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (structuredClone) | 987.4 KB | 600 | 0.650 ms (0.639–0.651) |
| envelope scan of 1 MB reasoning (extractAllEnvelopes) | 976.7 KB | 900 | 0.449 ms (0.446–0.453) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 0.441 ms (0.440–0.443) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.05 / 0.06 / 0.08 ms | 0.046 ms (0.046–0.051) | 21,585 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.00 ms | 0.001 ms (0.001–0.001) | 1,466,261 ops/s |

## Reference point

| workload | mean (min–max) |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.244 ms (0.243–0.244) |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.67 ms | 3.53 ms | +1.86 ms |
| non-stream, healthy (passthrough) | 1.56 ms | 3.26 ms | +1.70 ms |
| streaming, swallowed (recovery tail) | 1.61 ms | 3.34 ms | +1.73 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.004 ms (0.004–0.007) | 242,169 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.002 ms (0.002–0.002) | 633,204 ops/s |
| Pattern A — large reasoning (64KB) | 0.057 ms (0.057–0.057) | 17,600 ops/s |
| Pattern A — 1MB reasoning | 1.443 ms (1.430–1.495) | 693 ops/s |
| Pattern B — trailing text in content | 0.001 ms (0.001–0.002) | 718,520 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms (0.001–0.001) | 936,006 ops/s |
| Healthy — tool_calls already populated | 0.001 ms (0.001–0.001) | 1,069,176 ops/s |
| False-positive guard — discussion-only | 0.001 ms (0.001–0.002) | 745,246 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.3 KB | 9000 | 0.021 ms (0.021–0.025) | 47,035 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.011 ms (0.011–0.011) | 88,896 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.013 ms (0.013–0.015) | 74,378 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.032 ms (0.031–0.032) | 31,221 ops/s |
| fp-guard-multiple-partial | no | 0.3 KB | 9000 | 0.013 ms (0.013–0.013) | 78,827 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.012 ms (0.012–0.012) | 83,473 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.012 ms (0.012–0.012) | 85,289 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.012 ms (0.012–0.013) | 81,459 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.021 ms (0.021–0.026) | 48,616 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.012 ms (0.012–0.014) | 85,265 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.3 KB | 600 | 0.027 ms (0.023–0.030) | 36,488 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.018 ms (0.018–0.019) | 55,668 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.030 ms (0.029–0.034) | 33,574 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.019 ms (0.019–0.022) | 52,271 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.025 ms (0.022–0.026) | 39,502 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.021 ms (0.020–0.021) | 48,258 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.022 ms (0.022–0.025) | 45,610 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.011 ms (0.011–0.011) | 94,528 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.025 ms (0.024–0.025) | 40,329 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.4 KB | 9000 | 0.026 ms (0.025–0.026) | 38,664 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.022 ms (0.022–0.024) | 44,905 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.7 KB | 600 | 0.042 ms (0.039–0.064) | 23,530 ops/s |
