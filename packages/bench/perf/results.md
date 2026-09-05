# unswallow — performance report

measured 2026-09-05T01:34:35.133Z · v22.16.0 · win32 x64 · AMD Ryzen 5 2600X Six-Core Processor            (12 cores) · 15.9 GB RAM

Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the Python report must carry the same hash (cross-language "same seeds, same payloads" check).

## checkAndRescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.10 / 0.18 / 0.31 ms | 0.115 ms (0.096–0.134) | 8,729 ops/s | 0.01 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.13 / 0.30 / 0.70 ms | 0.151 ms (0.133–0.208) | 6,615 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.23 / 0.58 / 1.24 ms | 0.277 ms (0.195–0.361) | 3,607 ops/s | 0.00 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 3.52 / 8.38 / 11.85 ms | 4.029 ms (2.142–5.027) | 248 ops/s | 0.00 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.09 / 0.17 / 0.31 ms | 0.100 ms (0.086–0.135) | 9,985 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.05 / 0.09 / 0.13 ms | 0.057 ms (0.050–0.073) | 17,466 ops/s | 0.00 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.05 / 0.09 / 0.13 ms | 0.059 ms (0.050–0.067) | 16,993 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.05 / 0.09 / 0.11 ms | 0.057 ms (0.054–0.066) | 17,663 ops/s | 0.00 KB |

## Streaming (checkAndRescueStream)

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 2.44 / 4.37 / 5.71 ms | 2.420 ms (2.262–3.080) |
| 500 KB content stream | 5323 | 500.0 KB | 11.45 / 19.54 / 22.38 ms | 12.729 ms (10.426–14.048) |
| reference: same message, non-streaming checkAndRescue | — | — | 0.18 / 0.52 / 1.21 ms | 0.229 ms (0.202–0.293) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) |
| --- | --- | --- | --- |
| deep copy of 1 MB payload (structuredClone) | 987.4 KB | 600 | 1.880 ms (1.831–1.913) |
| envelope scan of 1 MB reasoning (extractAllEnvelopes) | 976.7 KB | 900 | 0.783 ms (0.738–1.017) |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 0.990 ms (0.981–1.058) |

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.09 / 0.20 / 0.63 ms | 0.114 ms (0.082–0.139) | 8,759 ops/s |

## Matrix lookup — matchMatrixEntry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.01 / 0.01 ms | 0.002 ms (0.001–0.002) | 615,366 ops/s |

## Reference point

| workload | mean (min–max) |
| --- | --- |
| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | 0.409 ms (0.317–0.420) |

## Proxy overhead (loopback, in-process upstream)

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 3.56 ms | 4.26 ms | +0.70 ms |
| non-stream, healthy (passthrough) | 0.82 ms | 1.97 ms | +1.15 ms |
| streaming, swallowed (recovery tail) | 1.04 ms | 2.54 ms | +1.50 ms |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.007 ms (0.005–0.009) | 135,400 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.002 ms (0.002–0.004) | 501,530 ops/s |
| Pattern A — large reasoning (64KB) | 0.094 ms (0.070–0.117) | 10,639 ops/s |
| Pattern A — 1MB reasoning | 2.048 ms (1.712–3.701) | 488 ops/s |
| Pattern B — trailing text in content | 0.003 ms (0.003–0.006) | 287,724 ops/s |
| Pattern C — field leak (detection-only) | 0.001 ms (0.001–0.002) | 862,738 ops/s |
| Healthy — tool_calls already populated | 0.002 ms (0.002–0.003) | 521,757 ops/s |
| False-positive guard — discussion-only | 0.003 ms (0.002–0.003) | 336,922 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | no | 0.3 KB | 9000 | 0.205 ms (0.189–0.219) | 4,884 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.067 ms (0.056–0.093) | 14,963 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.111 ms (0.067–0.131) | 9,020 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.233 ms (0.200–0.233) | 4,295 ops/s |
| fp-guard-multiple-partial | no | 0.3 KB | 9000 | 0.061 ms (0.055–0.064) | 16,336 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.055 ms (0.053–0.070) | 18,175 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.062 ms (0.055–0.063) | 16,076 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.069 ms (0.066–0.081) | 14,431 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.117 ms (0.100–0.140) | 8,546 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.058 ms (0.055–0.062) | 17,384 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.3 KB | 600 | 0.113 ms (0.108–0.117) | 8,828 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.183 ms (0.112–0.188) | 5,457 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.197 ms (0.191–0.199) | 5,065 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.223 ms (0.205–0.255) | 4,494 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.251 ms (0.186–0.265) | 3,988 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.221 ms (0.176–0.266) | 4,530 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.099 ms (0.095–0.103) | 10,143 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.048 ms (0.047–0.051) | 20,812 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.123 ms (0.108–0.124) | 8,148 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.4 KB | 9000 | 0.110 ms (0.106–0.125) | 9,073 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.171 ms (0.139–0.196) | 5,852 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.7 KB | 600 | 0.327 ms (0.297–0.358) | 3,061 ops/s |
