"""Runnable walkthrough (Python): the same vLLM 0.19 swallow shape through
the Python mirror — detect, recover, and prove the original is untouched.

Run: python packages/examples/walkthrough.py   (from the repo root)
Exits 0 only if every "broken → recovered" assertion holds.
"""
import json
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from unswallow import check_and_rescue

BROKEN = {
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

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }
]


def main():
    failures = []

    def check(label, ok):
        print(("PASS" if ok else "FAIL") + "  " + label)
        if not ok:
            failures.append(label)

    print("unswallow walkthrough (Python)\n")

    # 1. The broken path: the client sees a well-formed "no tool call" response.
    print("Step 1 — the swallow arrives as a normal-looking response")
    msg = BROKEN["choices"][0]["message"]
    check("message content is empty", msg["content"] == "")
    check("tool_calls is an empty array", msg["tool_calls"] == [])
    check("finish_reason is stop", BROKEN["choices"][0]["finish_reason"] == "stop")
    check(
        "an agent loop would stop here — the tool call is trapped in reasoning",
        "<tool_call>" in msg["reasoning"],
    )

    # 2. check_and_rescue detects it and returns a healed deep copy.
    print("\nStep 2 — check_and_rescue detects and recovers")
    original = deepcopy(BROKEN)
    result = check_and_rescue(BROKEN, engine_hint="vllm", engine_version="0.19.0", tool_schemas=TOOL_SCHEMAS)
    check("detected is true", result.detected is True)
    check("pattern is A (trapped inside reasoning)", result.pattern == "A")
    check("recovered is true", result.recovered is True)
    check("confidence is the matrix tier (0.95)", abs(result.confidence - 0.95) < 1e-9)
    check(
        "matrix row matched",
        result.matrix_match is not None and result.matrix_match.engine == "vllm" and result.matrix_match.behavior == "swallow",
    )
    check("original response is untouched (deep copy)", BROKEN["choices"][0]["message"]["tool_calls"] == [])
    check("tool_calls was rebuilt on the copy", len(result.recovered_response["choices"][0]["message"]["tool_calls"]) == 1)
    check(
        "recovered call name",
        result.recovered_response["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "get_weather",
    )
    args = result.recovered_response["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
    check("recovered call arguments", json.loads(args) == {"city": "Tokyo"})
    check(
        "finish_reason upgraded to tool_calls",
        result.recovered_response["choices"][0]["finish_reason"] == "tool_calls",
    )
    check("input dict was never mutated", BROKEN == original)

    # 3. The healthy path: already-parsed tool_calls pass through untouched.
    print("\nStep 3 — healthy responses pass through untouched")
    healthy = deepcopy(BROKEN)
    healthy["id"] = "chatcmpl-healthy"
    healthy["choices"][0]["finish_reason"] = "tool_calls"
    healthy["choices"][0]["message"]["tool_calls"] = [
        {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"Osaka"}'}}
    ]
    healthy_result = check_and_rescue(healthy, engine_hint="vllm", engine_version="0.24.0")
    check("not detected", healthy_result.detected is False)
    check("no recovery performed", healthy_result.recovered_response is None)

    # 4. The false-positive guard: discussion is never recovered.
    print("\nStep 4 — a model discussing a tool call is never recovered")
    discussion = deepcopy(BROKEN)
    discussion["id"] = "chatcmpl-discussion"
    discussion["choices"][0]["message"]["content"] = "I could call get_weather for Tokyo, but I do not need it."
    discussion["choices"][0]["message"].pop("reasoning")
    disc_result = check_and_rescue(discussion, engine_hint="vllm", engine_version="0.19.0")
    check("not detected", disc_result.detected is False)
    check("nothing recovered", disc_result.recovered is False and disc_result.recovered_response is None)

    print(("\nAll walkthrough assertions passed." if not failures else "\n{} assertion(s) failed.".format(len(failures))))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
