from __future__ import annotations

import re
from typing import Dict, List, Tuple

from .types import ChannelSource

REASONING_FIELDS: Tuple[str, ...] = ("reasoning", "reasoning_content", "thinking", "thought")

THINK_TAG = re.compile(r"<\s*(\/?)\s*([a-zA-Z0-9_.:\-]*?\s*(?:think|response))[^>]*>", re.I)


class Region:
    __slots__ = ("channel", "source", "text")

    def __init__(self, channel: str, source: str, text: str) -> None:
        self.channel = channel
        self.source = source
        self.text = text


def split_think_blocks(text: str) -> List[Region]:
    out: List[Region] = []
    depth = 0
    last = 0
    block_start = 0
    for m in THINK_TAG.finditer(text):
        is_close = m.group(1) == "/"
        name = m.group(2).strip()
        is_response = re.search(r"response", name, re.I) is not None
        is_open_think = not is_close and not is_response
        if is_open_think:
            if depth == 0:
                if m.start() > last:
                    out.append(Region("content", "field", text[last : m.start()]))
                block_start = m.start()
            depth += 1
        else:
            if depth > 0:
                depth -= 1
                if depth == 0:
                    out.append(Region("thinking", "think-block", text[block_start : m.end()]))
                    last = m.end()
    if depth > 0:
        out.append(Region("thinking", "leak", text[block_start:]))
        last = len(text)
    if last < len(text):
        out.append(Region("content", "field", text[last:]))
    if not out and text:
        out.append(Region("content", "field", text))
    return out


def extract_regions(message: Dict, additional_fields=None) -> List[Region]:
    regions: List[Region] = []
    fields = list(REASONING_FIELDS) + list(additional_fields or [])
    for f in fields:
        v = message.get(f)
        if isinstance(v, str) and v:
            regions.append(Region(f, "field", v))
    content = message.get("content")
    if isinstance(content, str) and content:
        regions.extend(split_think_blocks(content))
    return regions