from __future__ import annotations

from typing import List, Optional

from .types import SwallowMatrixEntry


class ConfidenceInput:
    __slots__ = (
        "pattern",
        "matrix_match",
        "engine_known",
        "version_known",
        "detection_only",
        "trailing_text",
        "arguments_from_string",
        "tool_schemas",
        "envelope_name",
    )

    def __init__(
        self,
        pattern,
        matrix_match: Optional[SwallowMatrixEntry],
        engine_known: bool,
        version_known: bool,
        detection_only: bool,
        trailing_text: bool,
        arguments_from_string: bool,
        tool_schemas=None,
        envelope_name: Optional[str] = None,
    ) -> None:
        self.pattern = pattern
        self.matrix_match = matrix_match
        self.engine_known = engine_known
        self.version_known = version_known
        self.detection_only = detection_only
        self.trailing_text = trailing_text
        self.arguments_from_string = arguments_from_string
        self.tool_schemas = tool_schemas
        self.envelope_name = envelope_name


def score_confidence(inp: ConfidenceInput):
    if not inp.pattern:
        return 0.0, []
    warnings: List[str] = []
    if inp.matrix_match:
        behavior = inp.matrix_match.behavior
        if behavior == "swallow":
            c = 0.95
        elif behavior == "partial":
            c = 0.8
        else:
            c = 0.6
        if behavior == "resolved":
            warnings.append(
                "matrix marks {} {} as resolved; a detection here means the reported engine version is likely wrong".format(
                    inp.matrix_match.engine, inp.matrix_match.version_range
                )
            )
    else:
        c = 0.55
        if not inp.engine_known:
            warnings.append("engine unknown; pass engine_hint for matrix-aware confidence")
        if not inp.version_known:
            warnings.append("engine version unknown; pass engine_version for matrix-aware confidence")
        if inp.engine_known and inp.version_known:
            warnings.append(
                "recovered via generic marker scan; engine/version not in the known matrix — verify manually"
            )
    if inp.detection_only:
        c = min(c, 0.5)
        warnings.append("pattern C is detection-only; no recovery performed")
    if inp.trailing_text:
        warnings.append(
            "trailing text after the envelope in content — recovered the JSON envelope; verify the tail is not part of the arguments"
        )
    if inp.arguments_from_string:
        warnings.append("arguments arrived as a JSON string and were parsed into an object")
    if inp.tool_schemas and inp.envelope_name:
        names = []
        for s in inp.tool_schemas:
            fn = s.get("function") if isinstance(s, dict) else None
            names.append((fn or s).get("name") if isinstance(fn or s, dict) else None)
        names = [n for n in names if n]
        if inp.envelope_name not in names:
            c -= 0.1
            warnings.append('recovered tool name "{}" not found in provided tool_schemas'.format(inp.envelope_name))
    confidence = max(0.0, min(1.0, round(c, 2)))
    return confidence, warnings