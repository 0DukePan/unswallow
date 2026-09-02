from __future__ import annotations

import copy
import json
import re
import uuid
from typing import Any, Dict, Optional

from .types import ToolEnvelope

XML_TOOL_CALL = re.compile(r"<(tool_call|tool_calls)\b[^>]*>", re.I)
FUNCTION_OPEN = re.compile(r"<function=([^>]*)>", re.I)
PARAMETER = re.compile(r"<parameter=([^>]*)>([\s\S]*?)</parameter\s*>", re.I)
NAME_ATTR = re.compile(r'name\s*=\s*"([^"]*)"', re.I)
MAX_ENVELOPE_LENGTH = 20000


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


def _extract_qwen_xml(text: str) -> Optional[ToolEnvelope]:
    m = XML_TOOL_CALL.search(text)
    if not m:
        return None
    tag = m.group(1)
    inner_start = m.end()
    close = _find_close(text, tag, inner_start)
    if not close:
        return None
    inner = text[inner_start : close[0]].strip()
    raw = text[m.start() : close[1]]
    if not inner or len(raw) > MAX_ENVELOPE_LENGTH:
        return None
    attr_m = NAME_ATTR.search(m.group(0))
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
            )
    if attr_name:
        params = {}
        any_param = False
        for pm in PARAMETER.finditer(inner):
            params[pm.group(1).strip()] = _coerce_scalar(pm.group(2))
            any_param = True
        if any_param:
            return ToolEnvelope(name=attr_name, arguments=params, raw=raw, format="qwen-xml")
    return None


def _extract_function_xml(text: str) -> Optional[ToolEnvelope]:
    m = FUNCTION_OPEN.search(text)
    if not m:
        return None
    name = m.group(1).strip().strip('"').strip("'")
    if not name:
        return None
    inner_start = m.end()
    close = _find_close(text, "function", inner_start)
    if not close:
        return None
    inner = text[inner_start : close[0]].strip()
    raw = text[m.start() : close[1]]
    if len(raw) > MAX_ENVELOPE_LENGTH:
        return None
    params = {}
    any_param = False
    for pm in PARAMETER.finditer(inner):
        params[pm.group(1).strip()] = _coerce_scalar(pm.group(2))
        any_param = True
    if any_param:
        return ToolEnvelope(name=name, arguments=params, raw=raw, format="function-xml")
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
            )
    return None


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


def _extract_json(text: str) -> Optional[ToolEnvelope]:
    i = 0
    while i < len(text):
        idx = text.find("{", i)
        if idx == -1:
            return None
        end = _scan_balanced_json(text, idx)
        if end == -1:
            i = idx + 1
            continue
        raw = text[idx:end]
        if len(raw) > MAX_ENVELOPE_LENGTH:
            i = idx + 1
            continue
        try:
            shape = validate_envelope_shape(json.loads(raw))
        except ValueError:
            shape = None
        if shape:
            return ToolEnvelope(
                name=shape["name"],
                arguments=shape["arguments"],
                arguments_from_string=shape["arguments_from_string"],
                raw=raw,
                format="json",
            )
        i = idx + 1
    return None


def extract_envelope(text: str) -> Optional[ToolEnvelope]:
    return _extract_qwen_xml(text) or _extract_function_xml(text) or _extract_json(text)


def build_tool_calls_entry(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": "call_" + uuid.uuid4().hex[:24],
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def apply_recovery_to_response(response: Dict[str, Any], name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    clone = copy.deepcopy(response)
    choice = clone["choices"][0]
    choice["message"]["tool_calls"] = [build_tool_calls_entry(name, arguments)]
    if choice.get("finish_reason") == "stop":
        choice["finish_reason"] = "tool_calls"
    return clone