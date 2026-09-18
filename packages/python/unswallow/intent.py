from __future__ import annotations

import re
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple

from .classify import ClassifiedHit
from .types import ToolIntentEvidence, ToolValidationResult

# How far around an envelope cue language is scanned.
CUE_WINDOW = 240
# Reasoning-channel prose longer than this after an envelope reads as a rehearsal.
TRAILING_PROSE_MIN = 80

REASONING_TAG = re.compile(r"<\s*\/?\s*[a-zA-Z0-9_.:\-]*\s*(?:think|response)[^>]*>", re.I)
QUOTE_CHARS = {'"', "'", "`", "\u201c", "\u201d", "\u2018", "\u2019"}

# Hard negation / illustration cues: their presence near an envelope withholds
# recovery (it is treated as quoted_tool_call material). Language cues may
# only ever *suppress* recovery — they never justify it.
NEGATION_CUES = (
    "do not execute",
    "don't execute",
    "not execute",
    "do not run",
    "don't run",
    "will not call",
    "won't call",
    "do not call",
    "don't call",
    "without calling",
    "illustrative only",
    "for illustration",
    "hypothetical",
    "if i were to call",
    "example only",
    "not a real call",
    "sample output",
    "example output",
    "the model would output",
    "would output",
    "for reference",
)

# Retraction cues: only meaningful after the envelope (draft then retract).
RETRACTION_CUES = (
    "actually, no",
    "actually no",
    "never mind",
    "nevermind",
    "scratch that",
    "on second thought",
    "disregard that",
)

# Soft planning cues: warning in `block` mode, blocking in `strict` mode.
PLANNING_CUES = (
    "i could",
    "i might",
    "maybe i",
    "perhaps i",
    "for example",
    "should i",
    "let me think",
)

# Report framing that turns a *fenced* envelope into quoted material. Consulted
# only while the envelope sits inside a fenced code block — a bare fence (models
# legitimately draft calls in fences) is never a veto by itself.
REPORT_CUES = (
    "outputs:",
    "output:",
    "would output",
    "would be",
    "example output",
    "sample output",
    "for reference",
)


def _fence_context(text: str, index: int) -> Tuple[bool, bool]:
    """Whether `index` sits inside a fenced code block, and whether the framing reads as reported output."""
    if "```" not in text and "~~~" not in text:
        return False, False
    count = 0
    last_start = -1
    line_start = 0
    while line_start < index:
        j = line_start
        while j < len(text) and text[j] in " \t":
            j += 1
        if text.startswith("```", j) or text.startswith("~~~", j):
            count += 1
            last_start = line_start
        nxt = text.find("\n", line_start)
        if nxt == -1 or nxt + 1 >= index:
            break
        line_start = nxt + 1
    if count % 2 == 0:
        return False, False
    annotation = text[max(0, last_start - 80) : index]
    return True, bool(_match_cues(annotation, REPORT_CUES))


class EnvelopeIntent:
    __slots__ = (
        "name",
        "reasoning",
        "terminal",
        "trailing_prose_chars",
        "negation_cues",
        "retraction_cues",
        "planning_cues",
        "quoted_context",
        "blocked",
    )

    def __init__(
        self,
        name: str,
        reasoning: bool,
        terminal: bool,
        trailing_prose_chars: int,
        negation_cues: List[str],
        retraction_cues: List[str],
        planning_cues: List[str],
        quoted_context: bool,
        blocked: List[str],
    ) -> None:
        self.name = name
        self.reasoning = reasoning
        self.terminal = terminal
        self.trailing_prose_chars = trailing_prose_chars
        self.negation_cues = negation_cues
        self.retraction_cues = retraction_cues
        self.planning_cues = planning_cues
        self.quoted_context = quoted_context
        self.blocked = blocked


class IntentEvaluation:
    __slots__ = ("category", "evidence", "per_envelope", "planning_cues")

    def __init__(
        self,
        category: Optional[str],
        evidence: ToolIntentEvidence,
        per_envelope: List[EnvelopeIntent],
        planning_cues: List[str],
    ) -> None:
        self.category = category
        self.evidence = evidence
        self.per_envelope = per_envelope
        self.planning_cues = planning_cues


def _mask_spans(text: str, spans: Sequence[Tuple[int, int]]) -> str:
    out: List[str] = []
    cursor = 0
    for start, end in sorted(spans):
        if start >= end:
            continue
        if start > cursor:
            out.append(text[cursor:start])
        out.append(" " * (end - start))
        cursor = max(cursor, end)
    out.append(text[cursor:])
    return "".join(out)


def _strip_to_prose(text: str) -> str:
    return re.sub(r"\s+", "", REASONING_TAG.sub("", text))


def _match_cues(text: str, cues: Sequence[str]) -> List[str]:
    lower = text.lower()
    return [cue for cue in cues if cue in lower]


def _non_whitespace_before(text: str, index: int) -> Optional[str]:
    for i in range(index - 1, -1, -1):
        if not text[i].isspace():
            return text[i]
    return None


def _non_whitespace_after(text: str, index: int) -> Optional[str]:
    for i in range(index, len(text)):
        if not text[i].isspace():
            return text[i]
    return None


def evaluate_intent(
    hits: List[ClassifiedHit],
    all_hits: List[ClassifiedHit],
    validations: List[ToolValidationResult],
    opts: Dict[str, Any],
    finish_reason: Optional[str] = None,
    capped: bool = False,
) -> IntentEvaluation:
    """Evaluate deterministic intent evidence and decide which envelopes may be recovered."""
    gate = opts.get("intent_gate")
    mode = gate if gate in ("strict", "off") else "block"
    expect = opts.get("expect_tool_call")
    expect_tool_call: Literal["yes", "no", "unknown"] = (
        "yes" if expect is True else "no" if expect is False else "unknown"
    )
    side_effecting = opts.get("side_effecting_tools")
    side_effecting = list(side_effecting) if isinstance(side_effecting, (list, tuple)) else []
    side_effecting_allowed = opts.get("recover_side_effecting") is True
    tool_schemas = opts.get("tool_schemas")
    schemas_supplied = isinstance(tool_schemas, (list, tuple)) and len(tool_schemas) > 0

    region_spans: Dict[int, Dict[str, Any]] = {}
    for hit in all_hits:
        region = region_spans.get(hit.region_id)
        if region is None:
            region = {"text": hit.region_text, "spans": []}
            region_spans[hit.region_id] = region
        region["spans"].append((hit.envelope.start, hit.envelope.end))
    masked_regions = {
        region_id: _mask_spans(region["text"], region["spans"])
        for region_id, region in region_spans.items()
    }

    per_envelope: List[EnvelopeIntent] = []
    all_cues: List[str] = []
    all_planning: List[str] = []
    any_quoted = False
    any_reasoning = False
    any_mid = False
    max_trailing = 0

    for i, hit in enumerate(hits):
        name = hit.envelope.name
        reasoning = hit.channel != "content"
        masked = masked_regions.get(hit.region_id, hit.region_text)
        start = hit.envelope.start
        end = hit.envelope.end
        before = masked[max(0, start - CUE_WINDOW) : start]
        after = masked[end : min(len(masked), end + CUE_WINDOW)]
        window_text = before + "\n" + after
        negation_cues = _match_cues(window_text, NEGATION_CUES)
        retraction_cues = _match_cues(after, RETRACTION_CUES)
        planning_cues = _match_cues(window_text, PLANNING_CUES)
        quote_wrapped = (
            _non_whitespace_before(masked, start) in QUOTE_CHARS
            and _non_whitespace_after(masked, end) in QUOTE_CHARS
        )
        fence_inside, fence_annotated = _fence_context(masked, start)
        quoted_context = quote_wrapped or (fence_inside and fence_annotated)

        # Prose after this envelope, excluding every later envelope's own span.
        later = sorted(
            (h for h in all_hits if h.region_id == hit.region_id and h.envelope.start >= end),
            key=lambda h: h.envelope.start,
        )
        trailing_parts: List[str] = []
        cursor = end
        for nxt in later:
            trailing_parts.append(hit.region_text[cursor : nxt.envelope.start])
            cursor = max(cursor, nxt.envelope.end)
        trailing_parts.append(hit.region_text[cursor:])
        trailing_prose_chars = len(_strip_to_prose("".join(trailing_parts)))
        terminal = trailing_prose_chars < TRAILING_PROSE_MIN if reasoning else True

        blocked: List[str] = []
        if mode != "off":
            if negation_cues:
                blocked.append(
                    'recovery blocked ({}): negated or illustrative language near the envelope ("{}")'.format(
                        name, negation_cues[0]
                    )
                )
            if retraction_cues:
                blocked.append(
                    'recovery blocked ({}): the call is retracted after being written ("{}")'.format(
                        name, retraction_cues[0]
                    )
                )
            if quoted_context:
                blocked.append(
                    "recovery blocked ({}): envelope appears inside quoted or reported text".format(name)
                )
            if reasoning and not terminal:
                if mode == "strict":
                    blocked.append(
                        "recovery blocked ({}): strict mode requires the envelope to end its reasoning channel ({} trailing chars)".format(
                            name, trailing_prose_chars
                        )
                    )
                elif not capped:
                    blocked.append(
                        "recovery blocked ({}): envelope is followed by reasoning prose ({} chars) — may be a rehearsal".format(
                            name, trailing_prose_chars
                        )
                    )
            if expect_tool_call == "no":
                blocked.append(
                    "recovery blocked ({}): the caller declared that no tool call was expected this turn".format(name)
                )
            if name in side_effecting and not side_effecting_allowed:
                blocked.append(
                    "recovery blocked ({}): tool is listed as side-effecting (pass recoverSideEffecting to allow)".format(
                        name
                    )
                )
            validation = validations[i] if i < len(validations) else None
            if validation is not None and validation.schema_valid == "no":
                blocked.append(
                    "recovery blocked ({}): arguments do not satisfy the supplied tool schema".format(name)
                )
            if schemas_supplied and validation is not None and validation.name_known == "no":
                blocked.append(
                    'recovery blocked ({}): tool name is not present in the supplied toolSchemas (pass intentGate "off" if the list is partial)'.format(
                        name
                    )
                )
            if mode == "strict":
                if planning_cues:
                    blocked.append(
                        'recovery blocked ({}): strict mode rejects planning language near the envelope ("{}")'.format(
                            name, planning_cues[0]
                        )
                    )
                if finish_reason and finish_reason != "stop":
                    blocked.append(
                        'recovery blocked ({}): strict mode requires finish_reason "stop" (got "{}")'.format(
                            name, finish_reason
                        )
                    )

        for cue in list(negation_cues) + list(retraction_cues) + list(planning_cues):
            if cue not in all_cues:
                all_cues.append(cue)
        for cue in planning_cues:
            if cue not in all_planning:
                all_planning.append(cue)
        if quoted_context:
            any_quoted = True
        if reasoning:
            any_reasoning = True
        if not terminal:
            any_mid = True
        max_trailing = max(max_trailing, trailing_prose_chars)

        per_envelope.append(
            EnvelopeIntent(
                name=name,
                reasoning=reasoning,
                terminal=terminal,
                trailing_prose_chars=trailing_prose_chars,
                negation_cues=negation_cues,
                retraction_cues=retraction_cues,
                planning_cues=planning_cues,
                quoted_context=quoted_context,
                blocked=blocked,
            )
        )

    quoted_veto = any(e.negation_cues or e.quoted_context for e in per_envelope)
    rehearsal_veto = (any_mid and not capped) or any(e.retraction_cues for e in per_envelope)
    if not hits:
        category = None
    elif quoted_veto:
        category = "quoted_tool_call"
    elif rehearsal_veto:
        category = "tool_rehearsal"
    else:
        category = "swallowed_tool_call"

    evidence = ToolIntentEvidence(
        boundary="mid" if any_mid else "terminal" if any_reasoning else "unknown",
        trailing_prose_chars=max_trailing,
        cues=all_cues,
        quoted_context=any_quoted,
        expect_tool_call=expect_tool_call,
        blocked=[reason for e in per_envelope for reason in e.blocked],
    )

    return IntentEvaluation(category=category, evidence=evidence, per_envelope=per_envelope, planning_cues=all_planning)
