from __future__ import annotations

import copy
import json
import re
import uuid
from typing import Any, Dict, Optional

from .types import ToolEnvelope

TOOL_OPEN_AT = re.compile(r"<(tool_call|tool_calls)\b[^>]*>", re.I)
FUNC_OPEN_AT = re.compile(r"<function=([^>]*)>", re.I)
PARAMETER = re.compile(r"<parameter=([^>]*)>([\s\S]*?)</parameter\s*>", re.I)
NAME_ATTR = re.compile(r'name\s*=\s*"([^"]*)"', re.I)
MAX_ENVELOPE_LENGTH = 20000
MAX_ENVELOPES = 32


def _find_close(text: str, tag: str, start: int) -> Optional[Tuple[int, int]]:
    m = re.search(r"</" + re.escape(tag) + r"\s*>", text[start:], re.I)
    if not m:
        return None
    return start + m.start(), start + m.end()


def _coerce_scalar(v: str) -> Any:
    t = v.strip()
    if re.match(r"^-?\d+$", t):
        return int(t)
    if re.match(r"^-?\d+\.\d+$", t):
        return float(t)
    if t == "true":
        return True
    if t == "false":
        return False
    if t == "null":
        return None
    return t


def validate_envelope_shape(obj: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(obj, dict):
        return None
    fn = obj.get("function")
    if not isinstance(fn, dict):
        fn = obj
    name = fn.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        return None
    args = fn.get("arguments")
    arguments_from_string = False
    if isinstance(args, str):
        try:
            args = json.loads(args)
            arguments_from_string = True
        except ValueError:
            return None
    if not isinstance(args, dict):
        return None
    return {"name": name.strip(), "arguments": args, "arguments_from_string": arguments_from_string}


def _try_qwen_at(text: str, tag: str, open_start: int, open_len: int) -> Optional[ToolEnvelope]:
    inner_start = open_start + open_len
    close = _find_close(text, tag, inner_start)
    if not close:
        return None
    inner = text[inner_start : close[0]].strip()
    raw = text[open_start : close[1]]
    if not inner or len(raw) > MAX_ENVELOPE_LENGTH:
        return None
    attr_m = NAME_ATTR.search(text[open_start:inner_start])
    attr_name = attr_m.group(1).strip() if attr_m else None
    if inner.startswith("{") or inner.startswith("["):
        try:
            shape = validate_envelope_shape(json.loads(inner))
        except ValueError:
            shape = None
        if shape:
            return ToolEnvelope(
                name=shape["name"],
                arguments=shape["arguments"],
                arguments_from_string=shape["arguments_from_string"],
                raw=raw,
                format="qwen-xml",
                start=open_start,
                end=close[1],
            )
    if attr_name:
        params = {}
        any_param = False
        for pm in PARAMETER.finditer(inner):
            params[pm.group(1).strip()] = _coerce_scalar(pm.group(2))
            any_param = True
        if any_param:
            return ToolEnvelope(name=attr_name, arguments=params, raw=raw, format="qwen-xml", start=open_start, end=close[1])
    return None


def _try_function_at(text: str, name: str, open_start: int, open_len: int) -> Optional[ToolEnvelope]:
    clean = name.strip().strip('"').strip("'")
    if not clean:
        return None
    inner_start = open_start + open_len
    close = _find_close(text, "function", inner_start)
    if not close:
        return None
    inner = text[inner_start : close[0]].strip()
    raw = text[open_start : close[1]]
    if len(raw) > MAX_ENVELOPE_LENGTH:
        return None
    params = {}
    any_param = False
    for pm in PARAMETER.finditer(inner):
        params[pm.group(1).strip()] = _coerce_scalar(pm.group(2))
        any_param = True
    if any_param:
        return ToolEnvelope(name=clean, arguments=params, raw=raw, format="function-xml", start=open_start, end=close[1])
    if inner.startswith("{"):
        try:
            shape = validate_envelope_shape(json.loads(inner))
        except ValueError:
            shape = None
        if shape:
            return ToolEnvelope(
                name=shape["name"],
                arguments=shape["arguments"],
                arguments_from_string=shape["arguments_from_string"],
                raw=raw,
                format="function-xml",
                start=open_start,
                end=close[1],
            )
    return None


def _try_json_at(text: str, brace_index: int) -> Optional[ToolEnvelope]:
    end = _scan_balanced_json(text, brace_index)
    if end == -1:
        return None
    raw = text[brace_index:end]
    if len(raw) > MAX_ENVELOPE_LENGTH:
        return None
    try:
        shape = validate_envelope_shape(json.loads(raw))
    except ValueError:
        return None
    if not shape:
        return None
    return ToolEnvelope(
        name=shape["name"],
        arguments=shape["arguments"],
        arguments_from_string=shape["arguments_from_string"],
        raw=raw,
        format="json",
        start=brace_index,
        end=end,
    )


def extract_all_envelopes(text: str):
    envelopes = []
    capped = False
    n = len(text)
    pos = 0
    guard = 0
    while pos < n:
        guard += 1
        if guard > n + 16:
            break
        if len(envelopes) >= MAX_ENVELOPES:
            capped = True
            break
        lt = text.find("<", pos)
        brace = text.find("{", pos)
        if lt == -1:
            nxt = brace
        elif brace == -1:
            nxt = lt
        else:
            nxt = lt if lt < brace else brace
        if nxt == -1:
            break
        if text[nxt] == "{":
            hit = _try_json_at(text, nxt)
            if hit:
                envelopes.append(hit)
                pos = hit.end
            else:
                pos = nxt + 1
            continue
        m = TOOL_OPEN_AT.match(text, nxt)
        if m:
            hit = _try_qwen_at(text, m.group(1), nxt, len(m.group(0)))
            if hit:
                envelopes.append(hit)
                pos = hit.end
            else:
                pos = nxt + len(m.group(0))
            continue
        m = FUNC_OPEN_AT.match(text, nxt)
        if m:
            hit = _try_function_at(text, m.group(1) or "", nxt, len(m.group(0)))
            if hit:
                envelopes.append(hit)
                pos = hit.end
            else:
                pos = nxt + len(m.group(0))
            continue
        pos = nxt + 1
    return envelopes, capped


def _scan_balanced_json(text: str, start: int) -> int:
    depth = 0
    in_string = False
    escaped = False
    i = start
    while i < len(text):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
                if depth == 0:
                    return i + 1
        i += 1
    return -1


def extract_envelope(text: str) -> Optional[ToolEnvelope]:
    found = extract_all_envelopes(text)[0]
    if not found:
        return None
    first = found[0]
    return ToolEnvelope(
        name=first.name,
        arguments=first.arguments,
        raw=first.raw,
        format=first.format,
        arguments_from_string=first.arguments_from_string,
    )


def build_tool_calls_entry(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": "call_" + uuid.uuid4().hex[:24],
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def apply_recovery_many(response: Dict[str, Any], calls) -> Dict[str, Any]:
    clone = copy.deepcopy(response)
    choice = clone["choices"][0]
    choice["message"]["tool_calls"] = [build_tool_calls_entry(c["name"], c["arguments"]) for c in calls]
    if choice.get("finish_reason") == "stop":
        choice["finish_reason"] = "tool_calls"
    return clone


def apply_recovery_to_response(response: Dict[str, Any], name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    return apply_recovery_many(response, [{"name": name, "arguments": arguments}])