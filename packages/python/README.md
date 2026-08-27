# unswallow (Python)

The 1:1 Python mirror of the `unswallow` TypeScript library: detect and recover tool calls trapped inside a model's reasoning channel — the reasoning-channel swallow bug class across vLLM, SGLang, and llama.cpp.

```bash
pip install unswallow
```

```python
from unswallow import check_and_rescue

result = check_and_rescue(
    raw_provider_response,
    engine_hint="vllm",
    engine_version="0.19.0",
    tool_schemas=my_tools,
)

if result.recovered and result.recovered_response:
    return result.recovered_response   # tool_calls is populated, finish_reason is "tool_calls"
```

Same interface, same semantics, same bundled matrix data (synced from `packages/matrix/data/engine-matrix.json`), zero runtime dependencies, Python 3.9+.

## Streaming

```python
from unswallow import check_and_rescue_stream

result = await check_and_rescue_stream(
    chunk_iterable,          # AsyncIterable of OpenAI-compatible SSE chunks
    engine_hint="vllm",
    engine_version="0.19.0",
    on_leak=logger.warning,  # live pattern-C signal, optional
)
```

Or accumulate manually with `StreamAccumulator` (`.push(chunk)` / `.end()`).

## History hygiene (Pattern D)

```python
from unswallow import sanitize_history, strip_reasoning_tags

clean = sanitize_history(messages)
text = strip_reasoning_tags(assistant_text)  # "< thinking>\nplan\n< response>\nanswer" -> "answer"
```

## CLI

```bash
unswallow check                                   # bundled self-test demo (vLLM #39056)
unswallow check --fixture response.json           # captured raw response
unswallow check --endpoint http://localhost:8000/v1 --model Qwen/Qwen3.5-35B-A3B-FP8 --engine vllm --version 0.19.0
unswallow matrix
```

Exit codes for live probes: `0` = not affected, `1` = affected, `2` = error.

## Development

```bash
cd packages/python
python -m unittest discover -s tests -v    # stdlib-only test suite
```

The engine matrix is bundled as data — after editing `packages/matrix/data/engine-matrix.json`, run `python packages/python/scripts/sync_matrix.py` from the repo root. CI verifies the copies stay identical.

Everything else — patterns, confidence scoring, the false-positive guard, the benchmark corpus and the engine matrix — is documented in the repository root [README](../../README.md).