from __future__ import annotations

from typing import Any, Dict

from .classify import classify
from .confidence import score_confidence
from .matrix import load_matrix, match_matrix_entry, normalize_engine
from .types import SwallowCheckResult, ToolCall, not_detected


def check_message(message: Dict[str, Any], **opts) -> SwallowCheckResult:
    matrix = load_matrix(opts.get("matrix"))
    engine = normalize_engine(opts.get("engine_hint"))
    version = opts.get("engine_version")
    if isinstance(version, str) and version.strip():
        version = version.strip()
    else:
        version = None

    cls = classify(message, opts.get("additional_fields"))

    if cls.pattern is None:
        return not_detected(engine)

    matrix_match = None
    if engine != "unknown" and version is not None:
        # normalize_engine narrows the possible spellings to the three known
        # engines or "unknown", so a cast here is safe after the check above.
        matrix_match = match_matrix_entry(matrix, engine, version, cls.pattern)  # type: ignore[arg-type]

    tool_call = None
    if cls.envelope:
        tool_call = ToolCall(name=cls.envelope.name, arguments=cls.envelope.arguments)
    tool_calls = [ToolCall(name=e.name, arguments=e.arguments) for e in cls.envelopes]
    recovered = cls.pattern != "C" and len(tool_calls) > 0

    confidence, warnings = score_confidence(
        confidence_input(cls, matrix_match, engine, version, opts)
    )

    return SwallowCheckResult(
        detected=True,
        pattern=cls.pattern,
        tool_call=tool_call,
        tool_calls=tool_calls,
        recovered=recovered,
        source=cls.source,
        engine_hint=engine,
        matrix_match=matrix_match,
        confidence=confidence,
        warnings=cls.reasons + warnings,
        recovered_response=None,
    )


def confidence_input(cls, matrix_match, engine: str, version, opts: Dict[str, Any]):
    from .confidence import ConfidenceInput

    return ConfidenceInput(
        pattern=cls.pattern,
        matrix_match=matrix_match,
        engine_known=engine != "unknown",
        version_known=version is not None,
        detection_only=cls.pattern == "C",
        trailing_text=any(r.startswith("trailing text") for r in cls.reasons),
        arguments_from_string=bool(cls.envelope and cls.envelope.arguments_from_string),
        tool_schemas=opts.get("tool_schemas"),
        envelope_name=cls.envelope.name if cls.envelope else None,
    )


def check_and_rescue(response: Dict[str, Any], **opts) -> SwallowCheckResult:
    from .recover import apply_recovery_many

    choices = response.get("choices") if isinstance(response, dict) else None
    if (
        not isinstance(choices, list)
        or not choices
        or not isinstance(choices[0], dict)
        or not isinstance(choices[0].get("message"), dict)
    ):
        from .matrix import normalize_engine as _ne

        return SwallowCheckResult(
            detected=False,
            pattern=None,
            tool_call=None,
            tool_calls=None,
            recovered=False,
            source="content",
            engine_hint=_ne(opts.get("engine_hint")),
            matrix_match=None,
            confidence=0.0,
            warnings=["response has no choices[0].message"],
            recovered_response=None,
        )

    result = check_message(choices[0]["message"], **opts)
    if result.recovered and result.tool_calls:
        result.recovered_response = apply_recovery_many(
            response, [{"name": t.name, "arguments": t.arguments} for t in result.tool_calls]
        )
    return result
