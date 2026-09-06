# Agent integrations

Runnable examples + recipes for wiring unswallow into real agent stacks. The
canonical flow every integration demonstrates:

**Normal response → swallowed tool call → unswallow → recovered tool call →
agent executes the tool.**

## The two seams

| seam | how | when to use |
| --- | --- | --- |
| **Wire level** | `unswallow proxy --upstream <base>/v1` — an OpenAI-compatible passthrough that heals responses in place (non-streaming) or appends a recovery tail (streaming) before the SDK ever parses them | Zero code change in the agent; works with any OpenAI-compatible SDK |
| **Application level** | `checkAndRescue(response)` / `check_and_rescue(...)` on the SDK's parsed response object | You control the response-handling code and want the diagnostics + deep copy in-process |

Both are exercised by the runnable examples below.

## Runnable examples (CI-green, zero extra dependencies)

| example | language | run |
| --- | --- | --- |
| `packages/examples/integration-openai.mjs` | TypeScript | `npm run integration` |
| `packages/examples/integration_openai.py` | Python | `npm run integration:python` |
| `packages/examples/integration_langchain.py` | Python (real LangChain) | `npm run integration:langchain` (via the runner) |
| `packages/examples/integration_llama_index.py` | Python (real LlamaIndex) | `npm run integration:langchain` (via the runner) |

The **real-framework** examples (`integration_langchain.py` +
`integration_llama_index.py`, driven by
`run_framework_integrations.py`) run against an actual installed
`langchain-openai` / `llama-index` + `openai` stack: a mock upstream that
swallows the tool call (it serves the live-captured b8461 swallow), the
unswallow proxy in front of it, and the framework's agent binding the tool.
They are verified end-to-end — the framework receives the healed response
and executes the recovered `read_file`. Install the deps in a venv and run
`npm run integration:langchain`, or trigger the `framework-integrations`
workflow (manual dispatch) in CI.

What the SDK-shape examples do (same assertions in both languages):

1. an SDK-shaped response arrives with `tool_calls: []` + `finish_reason: stop`
   while the call sits in `reasoning` (the vLLM 0.19 swallow shape);
2. `checkAndRescue` detects pattern A and returns a healed deep copy at
   matrix-tier confidence (0.95);
3. the agent loop reads `recoveredResponse.choices[0].message.tool_calls`,
   executes `get_weather({"city":"Tokyo"})`, and continues the turn;
4. a healthy response (already-parsed `tool_calls`) is left untouched.

The examples import `unswallow` from the workspace and assert on the raw
response objects — the exact same shape the OpenAI SDK returns from
`client.chat.completions.create(...)`, so swapping the simulated response for
a real SDK call is a one-line change.

## OpenAI SDK (real client, Python)

```bash
pip install openai unswallow
```

```python
from openai import OpenAI
from unswallow import check_and_rescue

client = OpenAI(base_url="http://localhost:8000/v1", api_key="none")  # vLLM/SGLang/llama.cpp

resp = client.chat.completions.create(
    model="Qwen/Qwen3-30B-A3B",
    messages=[{"role": "user", "content": "What is the weather in Tokyo?"}],
    tools=[{"type": "function", "function": {"name": "get_weather",
            "description": "Current weather for a city.",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                           "required": ["city"]}}}],
)
# The SDK hands you a parsed response; if the server swallowed the call,
# resp.choices[0].message.tool_calls is empty while reasoning carries the
# envelope. Heal it:
result = check_and_rescue(resp.model_dump(), engine_hint="vllm", engine_version="0.19.0")
if result.recovered and result.recovered_response:
    calls = result.recovered_response["choices"][0]["message"]["tool_calls"]
    for call in calls:                      # execute each recovered call
        print("execute", call["function"]["name"], call["function"]["arguments"])
```

Troubleshooting:

- `model_dump()` matters — unswallow takes plain dicts/JSON, not pydantic objects.
- Pass `engine_hint`/`engine_version` or confidence stays at the heuristic 0.55
  tier with warnings explaining why.
- Streaming: use `stream=True` with the SDK and run `check_and_rescue_stream`
  over the chunk iterator, or use the proxy seam and keep the SDK untouched.

## LangChain (Python)

**Verified with a real install** — see
`packages/examples/integration_langchain.py` (driven by
`run_framework_integrations.py`), which binds `read_file` on a
`ChatOpenAI` pointed at the unswallow proxy and executes the recovered
call. Reproduce it with `npm run integration:langchain` after
`pip install langchain-openai llama-index openai`.

```bash
pip install langchain-openai unswallow
```

The cleanest seam is the proxy — LangChain talks OpenAI-compatible HTTP, so
point it at the unswallow proxy and recovery happens before LangChain parses:

```python
from langchain_openai import ChatOpenAI

# 1. run: npx unswallow proxy --upstream http://localhost:8000/v1 \
#             --port 8787 --engine vllm --version 0.19.0
llm = ChatOpenAI(base_url="http://localhost:8787/v1", api_key="none", model="Qwen/Qwen3-30B-A3B")
```

Application-level alternative: wrap the raw response you receive from
`llm.invoke(...)` — the `AIMessage` carries `tool_calls` (parsed) and
`additional_kwargs` (raw); run `check_and_rescue` on the raw OpenAI-shaped
dict before binding tools, so the loop sees the recovered call:

```python
from langchain_core.messages import AIMessage

raw = {"choices": [{"message": ai_message_to_raw_dict(msg)}]}   # reconstruct the OpenAI shape
result = check_and_rescue(raw, engine_hint="vllm", engine_version="0.19.0")
if result.recovered_response:
    calls = result.recovered_response["choices"][0]["message"]["tool_calls"]
    # bind + execute as usual — the recovered calls are now visible
```

Limitations: LangChain normalizes tool calls into its own message schema, so
healing the *parsed* `AIMessage` means mapping back to the OpenAI wire shape
first — the proxy seam avoids that entirely and is the recommended path.

## LlamaIndex (Python)

**Verified with a real install** — see
`packages/examples/integration_llama_index.py`, which runs a
`FunctionAgent` (current llama-index workflow API, `api_base` pointed at
the unswallow proxy) that executes the recovered `read_file` and reports
the file contents. Note: llama-index validates the model name against
OpenAI's list, and its OpenAI LLM takes `api_base` (not `base_url`).

```bash
pip install llama-index-core llama-index-llms-openai unswallow
```

LlamaIndex's `OpenAIAgent`/`FunctionCallingAgent` also speak OpenAI-compatible
HTTP. Same two options: point the client at the proxy (`base_url` of the
proxy), or heal the raw response before it becomes an
`OpenAIResponse`/`AgentChatResponse`. Recovery-on-parse is the least invasive:

```python
from llama_index.core.llms import ChatResponse, MessageRole
from unswallow import check_and_rescue

# raw = the dict you received from the OpenAI-compatible endpoint
result = check_and_rescue(raw, engine_hint="vllm", engine_version="0.19.0")
if result.recovered_response:
    choice = result.recovered_response["choices"][0]
    message = choice["message"]
    # feed the recovered tool_calls into an AgentChatResponse and continue
```

Limitations: LlamaIndex versions differ in how they surface raw tool calls —
check your version's `ChatResponse.raw` before wiring this. The proxy seam is
the version-proof option.

## Custom tool-calling agent (any language)

The pattern is three lines no matter the stack:

```ts
// inside your response handler, after the SDK parsed the message:
const result = checkAndRescue(rawResponse, { engineHint, engineVersion, toolSchemas });
if (result.recovered && result.recoveredResponse) {
  rawResponse = result.recoveredResponse;            // tool_calls now populated
}
// …and your existing "if message.tool_calls → execute" branch just works
```

Rules that keep it safe:

- only act when `result.recovered === true` (structurally complete envelope);
- never mutate the original — always swap in `result.recoveredResponse`;
- pass `engineHint` + `engineVersion` (proxy flags `--engine`/`--version`) or
  accept heuristic confidence and its warnings;
- healthy responses (already-parsed `tool_calls`) return `detected: false` and
  cost ~nothing — no scanning happens on that path.

## Self-hosted inference setups

The harness + proxy are engine-agnostic OpenAI-compatible:

```bash
# llama.cpp (single model, no auth)
llama-server -m Qwen3-...-Q8_0.gguf --port 8080
npm run live-probe -- --endpoint http://127.0.0.1:8080/v1 --engine llama.cpp --version bXXXX

# vLLM / SGLang behind an OpenAI-compatible server
npm run live-probe -- --endpoint http://<host>:8000/v1 --engine vllm --version 0.19.0 \
    --model Qwen/Qwen3-30B-A3B --api-key <key>

# and in front of any of them, transparent recovery:
npx unswallow proxy --upstream http://<host>:8000/v1 --port 8787 --engine vllm --version 0.19.0
```

Live probes are how you find out whether *your* engine/version/model combo is
affected — see [reproduction.md](reproduction.md) and
[compatibility.md](compatibility.md). Nothing is assumed verified without a
recorded reproduction.

## Troubleshooting

| symptom | cause / fix |
| --- | --- |
| Confidence is 0.55, not 0.95 | No matrix hit — pass `engineHint`/`engineVersion` (or `--engine`/`--version`) |
| `recovered` is false but `detected` is true | Pattern C (leak) is detection-only by design, or the envelope is past the caps — read `warnings` |
| SDK says "tool_calls is not a valid field" | You passed a pydantic/model object — dump to a plain dict first (`model_dump()`/`.dict()`) |
| Proxy 404s on `/chat/completions` | Point it at the **base** URL (`…/v1`), not the full path |
| Nothing recovers on a real engine | The engine/version may be healthy — run the live probe and record the raw response; a clean result is a valid finding |
