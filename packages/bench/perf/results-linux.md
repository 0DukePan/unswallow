# unswallow — performance report

measured 2026-09-06T01:54:49.311Z · v22.23.2 · linux x64 · AMD EPYC 7763 64-Core Processor (4 cores) · 15.6 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the Python report must carry the same hash (cross-language "same seeds, same payloads" check).

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.02 / 0.04 / 0.06 ms | 0.023 ms (0.023–0.040) | 43,196 ops/s | 0.01 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.02 / 0.04 / 0.06 ms | 0.022 ms (0.022–0.032) | 44,518 ops/s | 0.02 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.06 / 0.07 / 0.09 ms | 0.060 ms (0.059–0.060) | 16,769 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 1.00 / 2.45 / 2.54 ms | 1.099 ms (1.090–1.103) | 910 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.02 / 0.04 / 0.05 ms | 0.022 ms (0.020–0.030) | 46,321 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.01 / 0.02 / 0.03 ms | 0.012 ms (0.011–0.015) | 84,297 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.01 / 0.01 / 0.02 ms | 0.010 ms (0.010–0.011) | 100,057 ops/s | 0.01 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.01 / 0.01 / 0.02 ms | 0.010 ms (0.010–0.012) | 99,492 ops/s | 0.00 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.68 / 0.85 / 1.09 ms | 0.697 ms (0.693–0.703) |
| 500 KB content stream | 5323 | 500.0 KB | 6.16 / 6.88 / 7.22 ms | 6.235 ms (6.119–6.375) |
| reference: same message, non-streaming checkAndRescue | — | — | 0.03 / 0.05 / 0.06 ms | 0.036 ms (0.033–0.038) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (structuredClone) | 987.4 KB | 600 | 0.543 ms (0.527–0.580) |
| envelope scan of 1 MB reasoning (extractAllEnvelopes) | 976.7 KB | 900 | 0.450 ms (0.448–0.451) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 0.419 ms (0.418–0.420) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.04 / 0.05 / 0.06 ms | 0.045 ms (0.045–0.047) | 22,070 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.00 ms | 0.001 ms (0.001–0.001) | 1,403,051 ops/s |

## Reference point

| workload | mean (min–max) |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.238 ms (0.238–0.239) |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 1.77 ms | 3.62 ms | +1.85 ms |
| non-stream, healthy (passthrough) | 1.60 ms | 3.36 ms | +1.76 ms |
| streaming, swallowed (recovery tail) | 1.68 ms | 3.41 ms | +1.73 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.004 ms (0.003–0.005) | 247,371 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.001 ms (0.001–0.002) | 676,513 ops/s |
| Pattern A — large reasoning (64KB) | 0.053 ms (0.052–0.053) | 19,040 ops/s |
| Pattern A — 1MB reasoning | 1.282 ms (1.250–1.316) | 780 ops/s |
| Pattern B — trailing text in content | 0.001 ms (0.001–0.002) | 739,587 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms (0.001–0.001) | 1,771,523 ops/s |
| Healthy — tool_calls already populated | 0.001 ms (0.001–0.001) | 1,107,273 ops/s |
| False-positive guard — discussion-only | 0.001 ms (0.001–0.001) | 822,078 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.3 KB | 9000 | 0.025 ms (0.025–0.033) | 39,753 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.010 ms (0.010–0.011) | 97,512 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.015 ms (0.014–0.017) | 64,919 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.036 ms (0.035–0.036) | 27,722 ops/s |
| fp-guard-multiple-partial | no | 0.3 KB | 9000 | 0.012 ms (0.012–0.013) | 80,400 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.011 ms (0.011–0.013) | 90,017 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.011 ms (0.011–0.011) | 91,938 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.012 ms (0.012–0.012) | 86,487 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.026 ms (0.025–0.035) | 39,062 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.011 ms (0.011–0.014) | 91,668 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.3 KB | 600 | 0.026 ms (0.024–0.029) | 38,282 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.020 ms (0.020–0.024) | 49,879 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.044 ms (0.041–0.049) | 22,725 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.023 ms (0.023–0.026) | 43,472 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.030 ms (0.026–0.033) | 33,766 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.025 ms (0.025–0.026) | 39,649 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.027 ms (0.027–0.031) | 37,262 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.010 ms (0.010–0.010) | 105,220 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.031 ms (0.029–0.032) | 32,423 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.4 KB | 9000 | 0.034 ms (0.031–0.034) | 29,596 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.028 ms (0.027–0.030) | 36,160 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.7 KB | 600 | 0.071 ms (0.062–0.076) | 14,171 ops/s |
