from __future__ import annotations

import re
from typing import AsyncIterable, Dict, List, Optional

from .pipeline import check_message
from .recover import apply_recovery_many
from .types import SwallowCheckResult

OPEN_TAG_AT = re.compile(r"^<\s*([a-zA-Z0-9_.:\-]*?\s*think)\s*>", re.I)
CLOSE_TAG_AT = re.compile(r"^<\s*\/\s*([a-zA-Z0-9_.:\-]*?\s*think)\s*>", re.I)
RESPONSE_TAG_AT = re.compile(r"^<\s*([a-zA-Z0-9_.:\-]*?\s*response)\s*>", re.I)

TAIL_SIZE = 64
DEFAULT_MAX_BUFFER_BYTES = 1_000_000

DELTA_FIELDS = ("content", "reasoning", "reasoning_content", "thinking", "thought")


class _ChannelTracker:
    def __init__(self) -> None:
        self.opens = 0
        self.closes = 0
        self._tail = ""
        self._in_string = False
        self._escaped = False

    def push(self, text: str) -> None:
        buf = self._tail + text
        i = 0
        while i < len(buf):
            ch = buf[i]
            if self._in_string:
                if self._escaped:
                    self._escaped = False
                elif ch == "\\":
                    self._escaped = True
                elif ch == '"':
                    self._in_string = False
                i += 1
                continue
            if ch == '"':
                self._in_string = True
                i += 1
                continue
            if ch == "<":
                rest = buf[i:]
                if OPEN_TAG_AT.match(rest):
                    self.opens += 1
                    i += 1
                    continue
                if CLOSE_TAG_AT.match(rest) or RESPONSE_TAG_AT.match(rest):
                    self.closes += 1
            i += 1
        self._tail = buf[-TAIL_SIZE:]


def _accumulate_tool_calls(message: Dict, delta_calls: List[Dict]) -> None:
    if not delta_calls:
        return
    message.setdefault("tool_calls", [])
    for dc in delta_calls:
        index = dc.get("index", len(message["tool_calls"]))
        while index >= len(message["tool_calls"]):
            message["tool_calls"].append(
                {"id": None, "type": None, "function": {"name": "", "arguments": ""}}
            )
        target = message["tool_calls"][index]
        if dc.get("id") and not target["id"]:
            target["id"] = dc["id"]
        if dc.get("type") and not target["type"]:
            target["type"] = dc["type"]
        fn = dc.get("function") or {}
        if fn.get("name") and not target["function"]["name"]:
            target["function"]["name"] = fn["name"]
        if fn.get("arguments"):
            target["function"]["arguments"] += fn["arguments"]


class StreamAccumulator:
    def __init__(self, max_buffer_bytes: int = DEFAULT_MAX_BUFFER_BYTES, on_leak=None) -> None:
        self._max_bytes = max_buffer_bytes
        self._on_leak = on_leak
        self._channels: Dict[str, _ChannelTracker] = {}
        self._texts: Dict[str, str] = {}
        self._raw_tool_calls: List[List[Dict]] = []
        self._total = 0
        self._last_finish_reason = None
        self._response_id = None
        self._response_model = None

    def push(self, chunk: Dict) -> None:
        if not isinstance(chunk, dict):
            return
        if chunk.get("id"):
            self._response_id = chunk["id"]
        if chunk.get("model"):
            self._response_model = chunk["model"]
        choices = chunk.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            return
        choice = choices[0]
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            return
        if choice.get("finish_reason"):
            self._last_finish_reason = choice["finish_reason"]
        if isinstance(delta.get("tool_calls"), list) and delta["tool_calls"]:
            self._raw_tool_calls.append(delta["tool_calls"])
        for field in DELTA_FIELDS:
            text = delta.get(field)
            if not isinstance(text, str) or not text:
                continue
            tracker = self._channels.setdefault(field, _ChannelTracker())
            tracker.push(text)
            if field == "content" and tracker.closes > tracker.opens and self._on_leak:
                self._on_leak("think tag closed without opening in the content channel (mid-stream leak)")
            self._texts[field] = self._texts.get(field, "") + text
            self._total += len(text)
            if self._total > self._max_bytes:
                raise ValueError(
                    "stream buffer exceeded {} bytes; pass max_buffer_bytes to raise the guard".format(
                        self._max_bytes
                    )
                )

    def end(self) -> Dict:
        message: Dict = {"role": "assistant"}
        for field, text in self._texts.items():
            if text:
                message[field] = text
            if field == "content" and self._channels[field].opens > self._channels[field].closes:
                if self._on_leak:
                    self._on_leak(
                        "unclosed think block in the content channel at stream end (pattern C field leak)"
                    )
        for dc in self._raw_tool_calls:
            _accumulate_tool_calls(message, dc)
        for tc in message.get("tool_calls") or []:
            for key in ("id", "type"):
                if tc.get(key) is None:
                    del tc[key]
        return {
            "id": self._response_id,
            "object": "chat.completion",
            "model": self._response_model,
            "choices": [
                {
                    "index": 0,
                    "finish_reason": self._last_finish_reason or "stop",
                    "message": message,
                }
            ],
        }


async def check_and_rescue_stream(
    stream: AsyncIterable[Dict], on_leak=None, **opts
) -> SwallowCheckResult:
    acc = StreamAccumulator(on_leak=on_leak, max_buffer_bytes=opts.pop("max_buffer_bytes", DEFAULT_MAX_BUFFER_BYTES))
    async for chunk in stream:
        acc.push(chunk)
    response = acc.end()
    result = check_message(response["choices"][0]["message"], **opts)
    if result.recovered and result.tool_calls:
        result.recovered_response = apply_recovery_many(
            response, [{"name": t.name, "arguments": t.arguments} for t in result.tool_calls]
        )
    return result