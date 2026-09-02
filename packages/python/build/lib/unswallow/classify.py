from __future__ import annotations

from typing import Dict, List, Optional

from .recover import extract_envelope
from .scan import extract_regions
from .types import ToolEnvelope


class Classification:
    __slots__ = ("pattern", "envelope", "source", "reasons")

    def __init__(self, pattern, envelope: Optional[ToolEnvelope], source: str, reasons: List[str]) -> None:
        self.pattern = pattern
        self.envelope = envelope
        self.source = source
        self.reasons = reasons


def classify(message: Dict, additional_fields=None) -> Classification:
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        return Classification(None, None, "content", ["response already carries tool_calls"])

    regions = extract_regions(message, additional_fields)
    reasoning_regions = [r for r in regions if r.channel != "content"]
    content_regions = [r for r in regions if r.channel == "content"]

    for region in reasoning_regions:
        envelope = extract_envelope(region.text)
        if envelope:
            reasons = [
                "tool-call envelope ({}) found inside {} channel{} while tool_calls is empty".format(
                    envelope.format,
                    region.channel,
                    " (think block in content)" if region.source == "think-block" else "",
                )
            ]
            content_envelopes = [extract_envelope(r.text) for r in content_regions]
            if any(content_envelopes):
                reasons.append("an additional envelope was found in content; recovered the reasoning-channel one")
            return Classification("A", envelope, region.channel, reasons)

    for region in content_regions:
        envelope = extract_envelope(region.text)
        if envelope:
            idx = region.text.find(envelope.raw)
            trailing = region.text[idx + len(envelope.raw) :].strip() if idx != -1 else ""
            if trailing:
                reason = "trailing text ({} chars) after tool-call envelope in content — strict JSON.parse would fail".format(
                    len(trailing)
                )
            else:
                reason = "complete tool-call envelope present in content but never parsed into tool_calls"
            return Classification("B", envelope, "content", [reason])

    if any(r.source == "leak" for r in regions):
        return Classification(
            "C",
            None,
            "thinking",
            ["reasoning tags leaked into the content field (unclosed think block)"],
        )

    return Classification(None, None, "content", [])