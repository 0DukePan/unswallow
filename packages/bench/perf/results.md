# unswallow — performance report

measured 2026-09-18T12:38:29.251Z · v22.16.0 · win32 x64 · AMD Ryzen 5 2600X Six-Core Processor            (12 cores) · 15.9 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the Python report must carry the same hash (cross-language "same seeds, same payloads" check).

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.10 / 0.15 / 0.20 ms | 0.110 ms (0.100–0.133) | 9,063 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.10 / 0.14 / 0.19 ms | 0.103 ms (0.100–0.118) | 9,668 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.15 / 0.18 / 0.42 ms | 0.153 ms (0.150–0.156) | 6,519 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 1.57 / 3.46 / 4.06 ms | 1.806 ms (1.659–2.122) | 554 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.10 / 0.12 / 0.16 ms | 0.102 ms (0.099–0.120) | 9,812 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.06 / 0.07 / 0.10 ms | 0.057 ms (0.051–0.066) | 17,421 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.04 / 0.05 / 0.08 ms | 0.046 ms (0.045–0.047) | 21,892 ops/s | 0.01 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.05 / 0.05 / 0.08 ms | 0.048 ms (0.046–0.049) | 20,942 ops/s | 0.00 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 0.85 / 1.21 / 1.56 ms | 0.886 ms (0.872–0.973) |
| 500 KB content stream | 5323 | 500.0 KB | 7.04 / 8.01 / 9.32 ms | 7.240 ms (7.119–7.276) |
| reference: same message, non-streaming checkAndRescue | — | — | 0.11 / 0.13 / 0.21 ms | 0.118 ms (0.118–0.123) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, the intent-gate evaluation (cue windows + envelope position), and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) | p95 |
| --- | --- | --- | --- | --- |
| deep copy of 1 MB payload (structuredClone) | 987.4 KB | 600 | 0.534 ms (0.495–0.566) | 1.976 ms |
| envelope scan of 1 MB reasoning (extractAllEnvelopes) | 976.7 KB | 900 | 0.517 ms (0.512–0.518) | 0.542 ms |
| intent gate on 1 MB reasoning (evaluateIntent) | 976.7 KB | 600 | 1.031 ms (0.963–1.114) | 2.400 ms |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 0.494 ms (0.494–0.512) | 0.549 ms |

`npm run bench:perf:check` fails when the intent-gate p95 exceeds 20 ms on the 1 MB payload (≈10× headroom over desktop numbers — a coarse regression tripwire, not a benchmark claim).

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.05 / 0.06 / 0.09 ms | 0.054 ms (0.053–0.058) | 18,669 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.00 / 0.00 ms | 0.001 ms (0.001–0.001) | 849,022 ops/s |

## Reference point

| workload | mean (min–max) |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.250 ms (0.244–0.255) |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 0.91 ms | 1.94 ms | +1.03 ms |
| non-stream, healthy (passthrough) | 0.69 ms | 1.48 ms | +0.79 ms |
| streaming, swallowed (recovery tail) | 0.64 ms | 1.55 ms | +0.91 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.005 ms (0.005–0.006) | 216,471 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.002 ms (0.002–0.002) | 539,665 ops/s |
| Pattern A — large reasoning (64KB) | 0.060 ms (0.055–0.069) | 16,561 ops/s |
| Pattern A — 1MB reasoning | 1.119 ms (1.106–1.213) | 893 ops/s |
| Pattern B — trailing text in content | 0.002 ms (0.002–0.004) | 434,405 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms (0.001–0.001) | 1,251,643 ops/s |
| Healthy — tool_calls already populated | 0.001 ms (0.001–0.002) | 933,576 ops/s |
| False-positive guard — discussion-only | 0.001 ms (0.001–0.001) | 752,276 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| adv-context-loss | no | 0.2 KB | 9000 | 0.047 ms (0.046–0.050) | 21,278 ops/s |
| adv-discussion-incomplete | no | 0.4 KB | 9000 | 0.047 ms (0.047–0.047) | 21,216 ops/s |
| adv-malformed-args-vs-schema | no | 0.4 KB | 9000 | 0.099 ms (0.098–0.115) | 10,089 ops/s |
| adv-mixed-genuine-rehearsed | no | 0.6 KB | 9000 | 0.130 ms (0.129–0.139) | 7,681 ops/s |
| adv-multiple-json-objects | no | 0.4 KB | 9000 | 0.053 ms (0.053–0.053) | 18,949 ops/s |
| adv-narration-content | no | 0.3 KB | 9000 | 0.079 ms (0.078–0.091) | 12,683 ops/s |
| adv-quoted-complete-negated | no | 0.4 KB | 9000 | 0.088 ms (0.086–0.095) | 11,373 ops/s |
| adv-quoted-report-context | no | 0.4 KB | 9000 | 0.080 ms (0.078–0.080) | 12,570 ops/s |
| adv-rehearsal-mid-reasoning | no | 0.6 KB | 9000 | 0.093 ms (0.093–0.105) | 10,776 ops/s |
| adv-retraction-after-call | no | 0.4 KB | 9000 | 0.089 ms (0.087–0.096) | 11,187 ops/s |
| adv-unknown-tool-name-vs-schema | no | 0.4 KB | 9000 | 0.101 ms (0.099–0.105) | 9,863 ops/s |
| deepseek-reasoning-content-pattern-a | no | 0.3 KB | 9000 | 0.098 ms (0.094–0.110) | 10,240 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.046 ms (0.046–0.047) | 21,738 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.057 ms (0.057–0.057) | 17,565 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.149 ms (0.138–0.150) | 6,728 ops/s |
| fp-guard-multiple-partial | no | 0.3 KB | 9000 | 0.052 ms (0.052–0.053) | 19,185 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.050 ms (0.050–0.053) | 19,872 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.050 ms (0.050–0.051) | 19,966 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.052 ms (0.052–0.053) | 19,276 ops/s |
| llamacpp-b8461-qwen3.5-9b-multiturn-pattern-a | no | 0.4 KB | 9000 | 0.100 ms (0.095–0.111) | 10,030 ops/s |
| llamacpp-b8461-qwen3.5-9b-streaming-multiturn-pattern-a | yes | 3.3 KB | 600 | 0.184 ms (0.178–0.185) | 5,445 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.108 ms (0.105–0.114) | 9,250 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.052 ms (0.052–0.061) | 19,214 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.3 KB | 600 | 0.086 ms (0.079–0.090) | 11,568 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.089 ms (0.087–0.090) | 11,280 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.126 ms (0.123–0.130) | 7,936 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.098 ms (0.096–0.103) | 10,214 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.099 ms (0.098–0.100) | 10,085 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.094 ms (0.094–0.094) | 10,635 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.101 ms (0.099–0.101) | 9,909 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.043 ms (0.043–0.044) | 23,058 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.108 ms (0.106–0.111) | 9,227 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.4 KB | 9000 | 0.114 ms (0.114–0.118) | 8,754 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.102 ms (0.101–0.102) | 9,803 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.7 KB | 600 | 0.135 ms (0.130–0.139) | 7,383 ops/s |
