# unswallow — Python false-positive & safety evaluation

generated 2026-09-18T13:00:37Z

Methodology and full definitions: [docs/false-positives.md](../../../docs/false-positives.md).

Evaluation engine matrix: v1.3.0 (updated 2026-09-06) — llama.cpp, sglang, vllm, 9 rows.

The pinned corpus is adversarial and small — these are regression counts over documented examples, **not** population estimates.

## Safety headline

| metric | value |
| --- | --- |
| detection recall (genuine swallows found) | 100.0% (11/11) |
| **unsafe recovery rate** (non-executable recovered) | 0.0% (0/19) |
| recovery precision (intended ÷ all recovered calls) | 100.0% (13/13) |
| detection false-positive rate (non-executable flagged) | 36.8% (7/19) |
| reconstruction correctness (recovered == expectedCalls) | 100.0% (12/12) |
| false negatives (genuine swallows missed) | 0 |
| false positives on seeded synthetic negatives | 0/200 |

Detection false positives are a candidate-classification event (annoying, low-stakes);
unsafe recovery is the dangerous failure mode and is gated separately — the CI check fails on any nonzero unsafe recovery.

## Per-category outcomes

| classification | fixtures | detected | recovered | recoverable |
| --- | --- | --- | --- | --- |
| (none) | 2 | 1 | 0 | 0 |
| context_loss | 1 | 0 | 0 | 0 |
| malformed_envelope | 7 | 2 | 0 | 0 |
| quoted_tool_call | 2 | 2 | 0 | 0 |
| swallowed_tool_call | 11 | 11 | 11 | 11 |
| tool_discussion | 3 | 0 | 0 | 0 |
| tool_rehearsal | 4 | 4 | 1 | 1 |
| unrelated_json | 1 | 0 | 0 | 0 |

## Pinned corpus

| fixture | classification | recoverable | detected | category | recovered | calls | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| adv-context-loss | context_loss | no | no | — | no | — | ok |
| adv-discussion-incomplete | tool_discussion | no | no | — | no | — | ok |
| adv-malformed-args-vs-schema | malformed_envelope | no | yes | swallowed_tool_call | no | — | ok |
| adv-mixed-genuine-rehearsed | tool_rehearsal | yes | yes | tool_rehearsal | yes | 1 | ok |
| adv-multiple-json-objects | unrelated_json | no | no | — | no | — | ok |
| adv-narration-content | tool_rehearsal | no | yes | tool_rehearsal | no | — | ok |
| adv-quoted-complete-negated | quoted_tool_call | no | yes | quoted_tool_call | no | — | ok |
| adv-quoted-report-context | quoted_tool_call | no | yes | quoted_tool_call | no | — | ok |
| adv-rehearsal-mid-reasoning | tool_rehearsal | no | yes | tool_rehearsal | no | — | ok |
| adv-retraction-after-call | tool_rehearsal | no | yes | tool_rehearsal | no | — | ok |
| adv-unknown-tool-name-vs-schema | malformed_envelope | no | yes | swallowed_tool_call | no | — | ok |
| deepseek-reasoning-content-pattern-a | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| fp-guard-discussion-only | tool_discussion | no | no | — | no | — | ok |
| fp-guard-json-array-args | malformed_envelope | no | no | — | no | — | ok |
| fp-guard-json-string-args | malformed_envelope | no | no | — | no | — | ok |
| fp-guard-multiple-partial | malformed_envelope | no | no | — | no | — | ok |
| fp-guard-partial-json | malformed_envelope | no | no | — | no | — | ok |
| fp-guard-user-content-mention | tool_discussion | no | no | — | no | — | ok |
| fp-guard-xml-empty-name | malformed_envelope | no | no | — | no | — | ok |
| llamacpp-b8461-qwen3.5-9b-multiturn-pattern-a | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| llamacpp-qwen3.5-thinking-pattern-a | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| minimax-m3-pattern-c-leak | — | no | yes | — | no | — | ok |
| pi-kimi2-pattern-b | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| sglang-qwen3.5-reasoning-content-pattern-a | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| vllm-qwen3-0.19-pattern-a-json-envelope | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| vllm-qwen3-0.23-pattern-a-partial | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| vllm-qwen3-0.24-clean | — | no | no | — | no | — | ok |
| vllm-qwen3.5-0.19-pattern-a-duplicate | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |
| vllm-qwen3.5-0.19-pattern-a-parallel | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 2 | ok |
| vllm-qwen3.5-0.19-pattern-a | swallowed_tool_call | yes | yes | swallowed_tool_call | yes | 1 | ok |

## Seeded synthetic negatives

200 seeded discussion-only reasoning samples (mulberry32 seed 0x66702d65) — a model thinking *about* calling a tool, never invoking one.

False positives on the synthetic negatives: 0/200
