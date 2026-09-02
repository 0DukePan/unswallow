from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Optional

from . import __version__
from .matrix import get_matrix_file
from .pipeline import check_and_rescue
from .types import SwallowCheckResult

PROBE_PROMPT = (
    "You are being evaluated on tool use. First, use your reasoning channel to plan which tool to "
    "call and what arguments to pass. Then actually invoke the get_weather tool for Tokyo. You must "
    "emit a real tool call — a plain-text answer is wrong."
)

PROBE_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "City name"}},
            "required": ["city"],
        },
    },
}

DEMO_RESPONSE = {
    "id": "chatcmpl-demo-39056",
    "object": "chat.completion",
    "created": 1785000000,
    "model": "Qwen/Qwen3.5-35B-A3B-FP8",
    "choices": [
        {
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\nI need to answer the user\u2019s question. The answer is 204.\n"
                    "<tool_call>\n<function=Finish>\n<parameter=answer>\n204\n</parameter>\n</function>\n"
                    "</tool_call>\n< response>\n"
                ),
                "tool_calls": [],
            },
        }
    ],
}


def _bar(frac: float, width: int = 10) -> str:
    filled = max(0, min(width, round(frac * width)))
    return "\u2588" * filled + "\u2591" * (width - filled)


def _read_fixture(path: str) -> tuple[dict, Optional[str], Optional[str]]:
    with open(path, encoding="utf-8") as f:
        parsed = json.load(f)
    if isinstance(parsed, dict) and "response" in parsed:
        hint = parsed.get("engineHint") or parsed.get("engine")
        ver = parsed.get("engineVersion") or parsed.get("version")
        return parsed["response"], hint, str(ver) if ver is not None else None
    return parsed, None, None


def _probe(endpoint: str, model: str, api_key: Optional[str], timeout: int):
    base = endpoint.rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    headers = {"content-type": "application/json"}
    if api_key:
        headers["authorization"] = "Bearer " + api_key
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": PROBE_PROMPT}],
            "tools": [PROBE_TOOL],
            "tool_choice": "auto",
            "stream": False,
        }
    ).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None
    except urllib.error.URLError as e:
        raise RuntimeError(str(e)) from e


def _render(result: SwallowCheckResult, engine: str, version: str) -> None:
    if not result.detected:
        print("\u2713 NO SWALLOW DETECTED")
        print("  no tool-call envelope found in any reasoning channel.")
        return
    pattern = result.pattern or "?"
    print("\u26a0 REASONING-CHANNEL SWALLOW DETECTED — Pattern {} ({})".format(pattern, {"A": "trapped inside", "B": "trailing after", "C": "field leak"}.get(pattern, "")))
    for w in result.warnings:
        if w.startswith("tool-call envelope"):
            print("  " + w)
    if result.recovered and result.tool_call is not None:
        print()
        print("  BEFORE                  AFTER")
        print("  tool_calls: []          tool_calls: [{}(\u2026)]".format(result.tool_call.name))
        print("  finish_reason: stop     finish_reason: tool_calls")
        print()
        print("  recovered: {}({})".format(result.tool_call.name, json.dumps(result.tool_call.arguments)))
    elif pattern == "C":
        print("  detection-only — no recovery performed (pattern C, see docs)")
    print()
    print("confidence    : {} {:.2f}".format(_bar(result.confidence), result.confidence))
    match = result.matrix_match
    if match:
        print("matrix match  : {} {} \u2192 {}".format(match.engine, match.version_range, match.behavior))
        print("source        : {}".format(match.source))
        if match.fix_hint:
            print("fix hint      : {}".format(match.fix_hint))
    else:
        missing = []
        if not engine:
            missing.append("--engine")
        if not version:
            missing.append("--version")
        print("matrix match  : none{}".format(" (pass {})".format(" ".join(missing)) if missing else ""))
    informational = [w for w in result.warnings if not w.startswith("tool-call envelope")]
    print("warnings      : {}".format("(none)" if not informational else ""))
    for w in informational:
        print("                " + w)


def _cmd_check(args: argparse.Namespace) -> int:
    if args.endpoint and args.fixture:
        print("error: --endpoint and --fixture are mutually exclusive", file=sys.stderr)
        return 3
    if args.endpoint:
        if not args.model:
            print("error: --endpoint requires --model", file=sys.stderr)
            return 3
        try:
            status, response = _probe(args.endpoint, args.model, args.api_key, args.timeout)
        except RuntimeError as e:
            print("probe failed: {}".format(e), file=sys.stderr)
            return 2
        if response is None:
            print("probe failed: endpoint returned HTTP {}".format(status), file=sys.stderr)
            return 2
        result = check_and_rescue(response, engine_hint=args.engine, engine_version=args.version)
        if args.json:
            print(json.dumps(_to_dict(result), indent=2))
            return 1 if result.detected else 0
        print("unswallow check — probe {}/chat/completions ({})".format(args.endpoint.rstrip("/"), status))
        print("model         : {}".format(args.model))
        print("engine        : {}{}".format(args.engine or "unknown", (" " + args.version) if args.version else ""))
        print("-" * 64)
        _render(result, args.engine, args.version)
        return 1 if result.detected else 0

    engine_hint = args.engine
    engine_version = args.version
    if args.fixture:
        try:
            source, hint, ver = _read_fixture(args.fixture)
        except (OSError, ValueError) as e:
            print("error: cannot read fixture: {}".format(e), file=sys.stderr)
            return 2
        src_desc = "fixture: " + args.fixture
        engine_hint = engine_hint or hint
        engine_version = engine_version or ver
    else:
        source = DEMO_RESPONSE
        src_desc = "self-test demo (bundled vLLM #39056 fixture)"
        engine_hint = engine_hint or "vllm"
        engine_version = engine_version or "0.19.0"

    result = check_and_rescue(source, engine_hint=engine_hint, engine_version=engine_version)
    if args.json:
        print(json.dumps(_to_dict(result), indent=2))
        return 0
    print("unswallow check — reasoning-channel swallow scan")
    print("source        : {}".format(src_desc))
    print("engine        : {}{}".format(engine_hint or "unknown", (" " + engine_version) if engine_version else ""))
    print("-" * 64)
    _render(result, engine_hint or "", engine_version or "")
    return 0


def _to_dict(result: SwallowCheckResult) -> dict:
    return {
        "detected": result.detected,
        "pattern": result.pattern,
        "toolCall": {"name": result.tool_call.name, "arguments": result.tool_call.arguments} if result.tool_call else None,
        "recovered": result.recovered,
        "source": result.source,
        "engineHint": result.engine_hint,
        "matrixMatch": result.matrix_match.__dict__ if result.matrix_match else None,
        "confidence": result.confidence,
        "warnings": result.warnings,
        "recoveredResponse": result.recovered_response,
    }


def _cmd_matrix(args: argparse.Namespace) -> int:
    file = get_matrix_file()
    entries = [e for e in file["entries"] if not args.engine or e.engine == args.engine or e.harness == args.engine]
    if args.json:
        print(json.dumps({"matrixVersion": file["matrixVersion"], "updated": file["updated"], "entries": [e.__dict__ for e in entries]}, indent=2))
        return 0
    print("unswallow engine matrix — v{} (updated {})".format(file["matrixVersion"], file["updated"]))
    print("every row is sourced; update via PR against packages/matrix/data/engine-matrix.json")
    print()
    for e in entries:
        print("  {:<14} {:<18} {:<8} {:<9} {}".format(e.engine or e.harness or "-", e.version_range, e.pattern, e.behavior, e.source.replace("https://github.com/", "")))
    return 0


def main(argv: Optional[list] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(prog="unswallow", description="Detect and recover tool calls trapped inside a model's reasoning channel.")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command")

    p_check = sub.add_parser("check", help="scan a response, fixture, or live endpoint")
    p_check.add_argument("--endpoint", help="OpenAI-compatible base URL to probe")
    p_check.add_argument("--model", help="model name for the probe")
    p_check.add_argument("--api-key", help="API key for the probe")
    p_check.add_argument("--engine", help="vllm | sglang | llama.cpp")
    p_check.add_argument("--version", help="server version")
    p_check.add_argument("--fixture", help="path to a captured raw response JSON (bench fixture or plain response)")
    p_check.add_argument("--timeout", type=int, default=60, help="probe timeout in seconds")
    p_check.add_argument("--json", action="store_true", help="machine-readable output")
    p_check.set_defaults(func=_cmd_check)

    p_matrix = sub.add_parser("matrix", help="print the engine/version behavior matrix")
    p_matrix.add_argument("--engine", help="filter by engine or harness")
    p_matrix.add_argument("--json", action="store_true")
    p_matrix.set_defaults(func=_cmd_matrix)

    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())