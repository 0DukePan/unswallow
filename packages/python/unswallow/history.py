from __future__ import annotations

import re
from typing import Dict, List

from .scan import split_think_blocks

REASONING_FIELDS = ("reasoning", "reasoning_content", "thinking", "thought")

DEEPSEEK_OPENER = re.compile(r"[^\x20-\x7E]{1,4}tool_call[^\x20-\x7E]{1,4}")
LEAK_TAG = re.compile(r"^<\s*([a-zA-Z0-9_.:\-]*?\s*think)\s*>", re.I)


def strip_reasoning_tags(text: str) -> str:
    if not isinstance(text, str) or not text:
        return text
    parts = split_think_blocks(text)
    out = []
    for r in parts:
        if r.channel == "content":
            out.append(r.text)
        elif r.source == "leak":
            out.append(LEAK_TAG.sub("", r.text, count=1))
    result = "".join(out)
    return DEEPSEEK_OPENER.sub("", result).strip()


def sanitize_history(messages: List[Dict], strip_reasoning_fields: bool = True, strip_reasoning_tags_opt: bool = True) -> List[Dict]:
    result = []
    for msg in messages:
        out = dict(msg)
        if strip_reasoning_fields:
            for f in REASONING_FIELDS:
                out.pop(f, None)
        content = out.get("content")
        if strip_reasoning_tags_opt and isinstance(content, str):
            out["content"] = strip_reasoning_tags(content)
        result.append(out)
    return result