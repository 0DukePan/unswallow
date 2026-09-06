"""Runnable integration example — OpenAI-compatible client (Python mirror).

The same vLLM 0.19 swallow shape through an OpenAI-SDK-style parsed
response, healed with check_and_rescue, then executed by a tiny agent
loop. Healthy responses pass through untouched.

Run: python packages/examples/integration_openai.py
Exits 0 only if every assertion holds.
"""
import json
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from unswallow import check_and_rescue  # noqa: E402

SWALLOWED_RESPONSE = {
    "id": "chatcmpl-vllm-0.19-swallowed",
    "object": "chat.completion",
    "model": "Qwen/Qwen3-30B-A3B",
    "choices": [
        {
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "<thinking>\nThe user wants the weather in Tokyo. I should use the get_weather tool.\n"
                    "<tool_call>\n{\"name\": \"get_weather\", \"arguments\": {\"city\": \"Tokyo\"}}\n"
                    "</tool_call>\n</thinking>\n"
                ),
                "tool_calls": [],
            },
        }
    ],
}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Current weather for a city.",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        },
    }
]

failures = []
executed = []


def check(label, ok):
    print(("PASS" if ok else "FAIL") + "  " + label)
    if not ok:
        failures.append(label)


def execute_tool(name, args):
    executed.append({"name": name, "args": args})
    if name == "get_weather":
        return {"temperature": 24, "condition": "sunny", "city": args["city"]}
    raise RuntimeError("unknown tool {}".format(name))


def main():
    print("unswallow x OpenAI-compatible client (python)\n")

    # Step 1 — the SDK's parsed response looks like a deliberate non-action.
    print('Step 1 — the client receives a well-formed "no tool call" response')
    sdk_response = deepcopy(SWALLOWED_RESPONSE)
    message = sdk_response["choices"][0]["message"]
    check("tool_calls is empty", isinstance(message["tool_calls"], list) and len(message["tool_calls"]) == 0)
    check("finish_reason is stop", sdk_response["choices"][0]["finish_reason"] == "stop")
    check("the agent loop would stop here (tool call trapped in reasoning)", "<tool_call>" in message["reasoning"])

    # Step 2 — application-level: run the response through unswallow.
    print("\nStep 2 — heal the response with check_and_rescue")
    result = check_and_rescue(sdk_response, engine_hint="vllm", engine_version="0.19.0", tool_schemas=TOOLS)
    check("detected (pattern A)", result.detected and result.pattern == "A")
    check("recovered with matrix-tier confidence", result.recovered and abs(result.confidence - 0.95) < 1e-9)
    check("original response untouched", len(message["tool_calls"]) == 0)

    # Step 3 — feed the recovered tool_calls to the agent loop.
    print("\nStep 3 — the agent executes the recovered tool call")
    recovered = result.recovered_response
    calls = recovered["choices"][0]["message"]["tool_calls"]
    check("tool_calls rebuilt with the call", len(calls) == 1 and calls[0]["function"]["name"] == "get_weather")
    check("finish_reason upgraded", recovered["choices"][0]["finish_reason"] == "tool_calls")
    for call in calls:
        output = execute_tool(call["function"]["name"], json.loads(call["function"]["arguments"]))
        check(
            "executed {} ({})".format(call["function"]["name"], call["function"]["arguments"]),
            output["city"] == "Tokyo" and output["temperature"] == 24,
        )

    # Step 4 — healthy responses pass through untouched.
    print("\nStep 4 — healthy responses never trigger recovery")
    healthy = deepcopy(SWALLOWED_RESPONSE)
    healthy["choices"][0]["finish_reason"] = "tool_calls"
    healthy["choices"][0]["message"]["tool_calls"] = [
        {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"Osaka"}'}}
    ]
    healthy_result = check_and_rescue(healthy, engine_hint="vllm", engine_version="0.24.0")
    check("not detected, nothing recovered", healthy_result.detected is False and healthy_result.recovered_response is None)

    print("\nExecuted tools: {}".format(json.dumps(executed)))
    print("\nAll integration assertions passed." if not failures else "\n{} assertion(s) failed.".format(len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
