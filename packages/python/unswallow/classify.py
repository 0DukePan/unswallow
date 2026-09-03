from __future__ import annotations

import json
from typing import Dict, List, Optional

from .recover import MAX_ENVELOPES, extract_all_envelopes
from .scan import extract_regions
from .types import ToolEnvelope


class ClassifiedHit:
    __slots__ = ("envelope", "channel", "think_block")

    def __init__(self, envelope: ToolEnvelope, channel: str, think_block: bool) -> None:
        self.envelope = envelope
        self.channel = channel
        self.think_block = think_block


class Classification:
    __slots__ = ("pattern", "envelope", "envelopes", "source", "reasons")

    def __init__(
        self,
        pattern,
        envelope: Optional[ToolEnvelope],
        envelopes: List[ToolEnvelope],
        source: str,
        reasons: List[str],
    ) -> None:
        self.pattern = pattern
        self.envelope = envelope
        self.envelopes = envelopes
        self.source = source
        self.reasons = reasons


def _dedupe(hits: List[ClassifiedHit]):
    seen = set()
    kept = []
    duplicates = 0
    for hit in hits:
        key = "{}\n{}".format(hit.envelope.name, json.dumps(hit.envelope.arguments))
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        kept.append(hit)
    return kept, duplicates


def _scan_channel(regions):
    hits: List[ClassifiedHit] = []
    capped = False
    trailing_chars = 0
    for region in regions:
        envelopes, region_capped = extract_all_envelopes(region.text)
        capped = capped or region_capped
        for envelope in envelopes:
            hits.append(ClassifiedHit(envelope, region.channel, region.source == "think-block"))
            tail = region.text[envelope.end :].strip()
            if tail:
                trailing_chars += len(tail)
    return hits, capped, trailing_chars


def _formats_of(hits: List[ClassifiedHit]) -> str:
    seen = []
    for h in hits:
        if h.envelope.format not in seen:
            seen.append(h.envelope.format)
    return ", ".join(seen)


def classify(message: Dict, additional_fields=None) -> Classification:
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        return Classification(None, None, [], "content", ["response already carries tool_calls"])

    regions = extract_regions(message, additional_fields)
    reasoning_regions = [r for r in regions if r.channel != "content"]
    content_regions = [r for r in regions if r.channel == "content"]

    reasoning_hits, reasoning_capped, _ = _scan_channel(reasoning_regions)
    if reasoning_hits:
        kept, duplicates = _dedupe(reasoning_hits)
        first = kept[0]
        if len(kept) == 1:
            reasons = [
                "tool-call envelope ({}) found inside {} channel{} while tool_calls is empty".format(
                    first.envelope.format,
                    first.channel,
                    " (think block in content)" if first.think_block else "",
                )
            ]
        else:
            reasons = [
                "{} tool-call envelopes ({}) found inside reasoning channel{} while tool_calls is empty".format(
                    len(kept),
                    _formats_of(kept),
                    " (think block in content)" if any(h.think_block for h in kept) else "",
                )
            ]
        if reasoning_capped:
            reasons.append("envelope scan capped at {}; recovered the first {}".format(MAX_ENVELOPES, MAX_ENVELOPES))
        if duplicates > 0:
            reasons.append("ignored {} duplicate tool-call envelope(s)".format(duplicates))
        content_hits, _, _ = _scan_channel(content_regions)
        if content_hits:
            reasons.append("additional envelope(s) found in content; recovered the reasoning-channel one(s)")
        return Classification(
            "A",
            kept[0].envelope,
            [h.envelope for h in kept],
            kept[0].channel,
            reasons,
        )

    content_hits, content_capped, trailing_chars = _scan_channel(content_regions)
    if content_hits:
        kept, duplicates = _dedupe(content_hits)
        if trailing_chars > 0:
            if len(kept) == 1:
                reasons = [
                    "trailing text ({} chars) after tool-call envelope in content — strict JSON.parse would fail".format(
                        trailing_chars
                    )
                ]
            else:
                reasons = [
                    "trailing text ({} chars) after tool-call envelopes in content — strict JSON.parse would fail".format(
                        trailing_chars
                    )
                ]
        else:
            reasons = [
                "complete tool-call envelope present in content but never parsed into tool_calls"
                if len(kept) == 1
                else "complete tool-call envelopes present in content but never parsed into tool_calls"
            ]
        if content_capped:
            reasons.append("envelope scan capped at {}; recovered the first {}".format(MAX_ENVELOPES, MAX_ENVELOPES))
        if duplicates > 0:
            reasons.append("ignored {} duplicate tool-call envelope(s)".format(duplicates))
        return Classification(
            "B",
            kept[0].envelope,
            [h.envelope for h in kept],
            "content",
            reasons,
        )

    if any(r.source == "leak" for r in regions):
        return Classification(
            "C",
            None,
            [],
            "thinking",
            ["reasoning tags leaked into the content field (unclosed think block)"],
        )

    return Classification(None, None, [], "content", [])