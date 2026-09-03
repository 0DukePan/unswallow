| id | engine | version | expected | actual | recovered | confidence | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
deepseek-reasoning-content-pattern-a | sglang | 0.4.6 | A | A | yes | 0.95 | PASS
fp-guard-discussion-only | vllm | 0.19.0 | none | none | no | 0.00 | PASS
fp-guard-partial-json | vllm | 0.19.0 | none | none | no | 0.00 | PASS
llamacpp-qwen3.5-thinking-pattern-a | llama.cpp | b8461 | A | A | yes | 0.95 | PASS
minimax-m3-pattern-c-leak | unknown | — | C | C | no | 0.50 | PASS
minimax-m3-streaming-pattern-c-leak | unknown | — | C | C | no | 0.50 | PASS
pi-kimi2-pattern-b | unknown | — | B | B | yes | 0.55 | PASS
pi-kimi2-streaming-pattern-b | unknown | — | B | B | yes | 0.55 | PASS
sglang-qwen3.5-reasoning-content-pattern-a | sglang | 0.4.6 | A | A | yes | 0.95 | PASS
vllm-qwen3-0.19-pattern-a-json-envelope | vllm | 0.19.0 | A | A | yes | 0.95 | PASS
vllm-qwen3-0.19-tool-choice-required-pattern-b | vllm | 0.19.0 | B | B | yes | 0.55 | PASS
vllm-qwen3-0.23-pattern-a-partial | vllm | 0.23.4 | A | A | yes | 0.80 | PASS
vllm-qwen3-0.24-clean | vllm | 0.24.0 | none | none | no | 0.00 | PASS
vllm-qwen3.5-0.19-pattern-a-duplicate | vllm | 0.19.0 | A | A | yes | 0.95 | PASS
vllm-qwen3.5-0.19-pattern-a-parallel | vllm | 0.19.0 | A | A | yes | 0.95 | PASS
vllm-qwen3.5-0.19-pattern-a | vllm | 0.19.0 | A | A | yes | 0.95 | PASS
vllm-qwen3.5-0.19-streaming-pattern-a | vllm | 0.19.0 | A | A | yes | 0.95 | PASS

**17/17 fixtures passing** — fixtures are hash-pinned (see `fixtures.sha256`); engine/version hints per fixture; every `source` is cited in the fixture file. Matrix↔fixture consistency: 11/11.
