# unswallow — Python false-positive evaluation

generated 2026-09-06T02:48:03Z

Methodology and full definitions: [docs/false-positives.md](../../../docs/false-positives.md).

Evaluation engine matrix: v1.3.0 (updated 2026-09-06) — llama.cpp, sglang, vllm, 8 rows.

The pinned corpus is adversarial and small — these are regression counts over documented examples, **not** population estimates.

## Results

| metric | count |
| --- | --- |
| pinned positive examples (real swallow shapes) | 12 |
| pinned negative examples (discussion / near-miss) | 8 |
| seeded synthetic negatives | 200 |
| false positives (pinned negatives detected) | 0 |
| false negatives (pinned positives missed) | 0 |
| false positives (synthetic negatives) | 0 |
| detection accuracy on the pinned corpus | 100.0% |

## Confusion-matrix metrics (pinned corpus)

| metric | value |
| --- | --- |
| true positives | 12 |
| false positives | 0 |
| true negatives | 8 |
| false negatives | 0 |
| precision (TP / (TP + FP)) | 100.0% |
| recall (TP / (TP + FN)) | 100.0% |
| specificity (TN / (TN + FP)) | 100.0% |
| F1 | 1.000 |

These are regression counts over the documented corpus, not population estimates — see [docs/false-positives.md](../../../docs/false-positives.md).

## Pinned corpus

| fixture | label | expected | detected | recovered | verdict |
| --- | --- | --- | --- | --- | --- |
| deepseek-reasoning-content-pattern-a | positive | detect | yes | yes | ok |
| fp-guard-discussion-only | negative | none | no | no | ok |
| fp-guard-json-array-args | negative | none | no | no | ok |
| fp-guard-json-string-args | negative | none | no | no | ok |
| fp-guard-multiple-partial | negative | none | no | no | ok |
| fp-guard-partial-json | negative | none | no | no | ok |
| fp-guard-user-content-mention | negative | none | no | no | ok |
| fp-guard-xml-empty-name | negative | none | no | no | ok |
| llamacpp-b8461-qwen3.5-9b-multiturn-pattern-a | positive | detect | yes | yes | ok |
| llamacpp-qwen3.5-thinking-pattern-a | positive | detect | yes | yes | ok |
| minimax-m3-pattern-c-leak | positive | detect | yes | no | ok |
| pi-kimi2-pattern-b | positive | detect | yes | yes | ok |
| sglang-qwen3.5-reasoning-content-pattern-a | positive | detect | yes | yes | ok |
| vllm-qwen3-0.19-pattern-a-json-envelope | positive | detect | yes | yes | ok |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | positive | detect | yes | yes | ok |
| vllm-qwen3-0.23-pattern-a-partial | positive | detect | yes | yes | ok |
| vllm-qwen3-0.24-clean | negative | none | no | no | ok |
| vllm-qwen3.5-0.19-pattern-a-duplicate | positive | detect | yes | yes | ok |
| vllm-qwen3.5-0.19-pattern-a-parallel | positive | detect | yes | yes | ok |
| vllm-qwen3.5-0.19-pattern-a | positive | detect | yes | yes | ok |

## Seeded synthetic negatives

200 seeded discussion-only reasoning samples (mulberry32 seed 0x66702d65) — a model thinking *about* calling a tool, never invoking one.

False positives on the synthetic negatives: 0/200
