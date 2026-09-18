# unswallow — Python performance report

measured 2026-09-18T12:37:44Z · Python 3.14.6 · windows amd64

Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).

Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses.

Corpus identity: sha256 of the a-small payload pool is 3066ff5af221e77be529abf53c79ebff269a0ec3f02b808774e510a1027e6782 — the TypeScript report must carry the same hash (cross-language "same seeds, same payloads" check).

## check_and_rescue — latency per call (warm)

| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |
| --- | --- | --- | --- | --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 2.8 KB | 15000 | 0.28 / 0.39 / 0.49 ms | 0.295 ms (0.293–0.300) | 3,384 ops/s | 0.00 KB |
| Pattern A — function-XML envelope (~1.5KB) | 1.8 KB | 15000 | 0.29 / 0.40 / 0.51 ms | 0.301 ms (0.298–0.316) | 3,320 ops/s | 0.01 KB |
| Pattern A — large reasoning (64KB) | 63.5 KB | 2500 | 0.30 / 0.36 / 0.44 ms | 0.306 ms (0.297–0.316) | 3,270 ops/s | 0.05 KB |
| Pattern A — 1MB reasoning | 987.4 KB | 500 | 0.93 / 1.67 / 2.04 ms | 1.012 ms (0.922–1.142) | 988 ops/s | 0.18 KB |
| Pattern B — trailing text in content | 1.0 KB | 10000 | 0.31 / 0.42 / 0.55 ms | 0.332 ms (0.319–0.339) | 3,008 ops/s | 0.01 KB |
| Pattern C — field leak (detection-only) | 0.5 KB | 10000 | 0.20 / 0.24 / 0.33 ms | 0.206 ms (0.205–0.213) | 4,862 ops/s | 0.01 KB |
| Healthy — tool_calls already populated | 1.1 KB | 10000 | 0.16 / 0.22 / 0.28 ms | 0.170 ms (0.165–0.176) | 5,875 ops/s | 0.00 KB |
| False-positive guard — discussion-only | 1.5 KB | 10000 | 0.17 / 0.25 / 0.32 ms | 0.185 ms (0.180–0.191) | 5,406 ops/s | 0.01 KB |

## check_and_rescue_stream

| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |
| --- | --- | --- | --- | --- |
| typical reasoning stream, envelope split across deltas | 843 | 19.7 KB | 13.75 / 16.51 / 17.79 ms | 14.000 ms (13.957–14.125) |

## Component probes (why TS and Python diverge)

The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, the intent-gate evaluation (cue windows + envelope position), and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).

| probe | payload | n | mean (min–max) | p95 |
| --- | --- | --- | --- | --- |
| deep copy of 1 MB payload (copy.deepcopy) | 987.4 KB | 600 | 0.008 ms (0.008–0.008) | 0.008 ms |
| envelope scan of 1 MB reasoning (extract_all_envelopes) | 976.7 KB | 900 | 0.194 ms (0.191–0.200) | 0.223 ms |
| intent gate on 1 MB reasoning (evaluate_intent) | 976.7 KB | 600 | 0.276 ms (0.270–0.281) | 0.311 ms |
| leak-tracker loop, 843 chunk pushes (19.7 KB) | — | 600 | 12.282 ms (12.271–12.305) | 14.020 ms |

`python packages/python/bench/perf_python.py --check` fails when the intent-gate p95 exceeds 20 ms on the 1 MB payload (≈10× headroom over desktop numbers — a coarse regression tripwire, not a benchmark claim).

## Pattern D — sanitizeHistory

| corpus | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 40-message history with leaked reasoning | 0.36 / 0.56 / 0.64 ms | 0.389 ms (0.383–0.396) | 2,571 ops/s |

## Matrix lookup — match_matrix_entry

| workload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- |
| 100k lookups (engine/version/pattern) | 0.00 / 0.04 / 0.04 ms | 0.009 ms (0.009–0.009) | 108,535 ops/s |

## Naive baseline (marker scan, no validation, no recovery)

What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.

| scenario | mean (min–max) | throughput |
| --- | --- | --- |
| Pattern A — small reasoning (~2–3KB) | 0.026 ms (0.025–0.028) | 38,708 ops/s |
| Pattern A — function-XML envelope (~1.5KB) | 0.009 ms (0.009–0.010) | 106,638 ops/s |
| Pattern A — large reasoning (64KB) | 0.306 ms (0.301–0.316) | 3,270 ops/s |
| Pattern A — 1MB reasoning | 4.752 ms (4.670–5.014) | 210 ops/s |
| Pattern B — trailing text in content | 0.016 ms (0.014–0.016) | 63,784 ops/s |
| Pattern C — field leak (detection-only) | 0.004 ms (0.004–0.005) | 243,970 ops/s |
| Healthy — tool_calls already populated | 0.006 ms (0.006–0.007) | 162,527 ops/s |
| False-positive guard — discussion-only | 0.008 ms (0.008–0.008) | 123,865 ops/s |

False positives on the pinned guard fixtures (naive fired where nothing should recover): 6/7 (fp-guard-json-array-args, fp-guard-json-string-args, fp-guard-multiple-partial, fp-guard-partial-json, fp-guard-user-content-mention, fp-guard-xml-empty-name)

## Real fixture corpus (pinned upstream-derived shapes)

The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.

| fixture | stream | payload | n | mean (min–max) | throughput |
| --- | --- | --- | --- | --- | --- |
| adv-context-loss | no | 0.2 KB | 9000 | 0.186 ms (0.182–0.186) | 5,383 ops/s |
| adv-discussion-incomplete | no | 0.4 KB | 9000 | 0.183 ms (0.182–0.183) | 5,478 ops/s |
| adv-malformed-args-vs-schema | no | 0.4 KB | 9000 | 0.333 ms (0.326–0.346) | 3,003 ops/s |
| adv-mixed-genuine-rehearsed | no | 0.6 KB | 9000 | 0.392 ms (0.386–0.396) | 2,547 ops/s |
| adv-multiple-json-objects | no | 0.4 KB | 9000 | 0.204 ms (0.204–0.206) | 4,907 ops/s |
| adv-narration-content | no | 0.3 KB | 9000 | 0.282 ms (0.280–0.282) | 3,546 ops/s |
| adv-quoted-complete-negated | no | 0.4 KB | 9000 | 0.312 ms (0.312–0.317) | 3,202 ops/s |
| adv-quoted-report-context | no | 0.4 KB | 9000 | 0.306 ms (0.301–0.310) | 3,270 ops/s |
| adv-rehearsal-mid-reasoning | no | 0.7 KB | 8889 | 0.327 ms (0.317–0.327) | 3,062 ops/s |
| adv-retraction-after-call | no | 0.4 KB | 9000 | 0.314 ms (0.311–0.314) | 3,182 ops/s |
| adv-unknown-tool-name-vs-schema | no | 0.4 KB | 9000 | 0.329 ms (0.328–0.330) | 3,038 ops/s |
| deepseek-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.305 ms (0.303–0.309) | 3,280 ops/s |
| fp-guard-discussion-only | no | 0.4 KB | 9000 | 0.182 ms (0.178–0.185) | 5,485 ops/s |
| fp-guard-json-array-args | no | 0.3 KB | 9000 | 0.209 ms (0.209–0.215) | 4,774 ops/s |
| fp-guard-json-string-args | no | 0.3 KB | 9000 | 0.229 ms (0.224–0.231) | 4,365 ops/s |
| fp-guard-multiple-partial | no | 0.4 KB | 9000 | 0.213 ms (0.212–0.215) | 4,686 ops/s |
| fp-guard-partial-json | no | 0.4 KB | 9000 | 0.206 ms (0.204–0.212) | 4,853 ops/s |
| fp-guard-user-content-mention | no | 0.3 KB | 9000 | 0.191 ms (0.191–0.194) | 5,243 ops/s |
| fp-guard-xml-empty-name | no | 0.3 KB | 9000 | 0.201 ms (0.199–0.203) | 4,983 ops/s |
| llamacpp-b8461-qwen3.5-9b-multiturn-pattern-a | no | 0.4 KB | 9000 | 0.312 ms (0.311–0.315) | 3,205 ops/s |
| llamacpp-b8461-qwen3.5-9b-streaming-multiturn-pattern-a | yes | 3.6 KB | 600 | 0.822 ms (0.819–0.847) | 1,215 ops/s |
| llamacpp-qwen3.5-thinking-pattern-a | no | 0.4 KB | 9000 | 0.316 ms (0.311–0.317) | 3,168 ops/s |
| minimax-m3-pattern-c-leak | no | 0.3 KB | 9000 | 0.215 ms (0.211–0.216) | 4,642 ops/s |
| minimax-m3-streaming-pattern-c-leak | yes | 0.4 KB | 600 | 0.245 ms (0.243–0.247) | 4,085 ops/s |
| pi-kimi2-pattern-b | no | 0.4 KB | 9000 | 0.287 ms (0.287–0.293) | 3,483 ops/s |
| pi-kimi2-streaming-pattern-b | yes | 0.5 KB | 600 | 0.354 ms (0.347–0.355) | 2,828 ops/s |
| sglang-qwen3.5-reasoning-content-pattern-a | no | 0.4 KB | 9000 | 0.311 ms (0.309–0.312) | 3,220 ops/s |
| vllm-qwen3-0.19-pattern-a-json-envelope | no | 0.4 KB | 9000 | 0.335 ms (0.328–0.341) | 2,987 ops/s |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | no | 0.3 KB | 9000 | 0.319 ms (0.316–0.321) | 3,134 ops/s |
| vllm-qwen3-0.23-pattern-a-partial | no | 0.3 KB | 9000 | 0.352 ms (0.349–0.359) | 2,838 ops/s |
| vllm-qwen3-0.24-clean | no | 0.4 KB | 9000 | 0.176 ms (0.173–0.181) | 5,686 ops/s |
| vllm-qwen3.5-0.19-pattern-a-duplicate | no | 0.4 KB | 9000 | 0.354 ms (0.348–0.357) | 2,825 ops/s |
| vllm-qwen3.5-0.19-pattern-a-parallel | no | 0.5 KB | 9000 | 0.385 ms (0.380–0.389) | 2,596 ops/s |
| vllm-qwen3.5-0.19-pattern-a | no | 0.4 KB | 9000 | 0.355 ms (0.336–0.355) | 2,818 ops/s |
| vllm-qwen3.5-0.19-streaming-pattern-a | yes | 0.8 KB | 600 | 0.453 ms (0.440–0.455) | 2,208 ops/s |
