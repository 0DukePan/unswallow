from __future__ import annotations

from typing import Any, Dict, List, Optional

from .classify import classify
from .confidence import score_confidence
from .intent import evaluate_intent
from .matrix import load_matrix, match_matrix_entry, normalize_engine
from .types import SwallowCheckResult, ToolCall, not_detected
from .validate import validate_envelope


def check_message(
    message: Dict[str, Any],
    finish_reason: Optional[str] = None,
    **opts: Any
) -> SwallowCheckResult:
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
    validations = [validate_envelope(envelope, opts.get("tool_schemas")) for envelope in cls.envelopes]
    validation = validations[0] if validations else validate_envelope(cls.envelope, opts.get("tool_schemas"))
    all_structurally_valid = all(result.structurally_valid for result in validations)
    all_schemas_valid = all(result.schema_valid == "yes" for result in validations)

    confidence, conf_warnings = score_confidence(
        confidence_input(cls, matrix_match, engine, version, validation)
    )

    intent = evaluate_intent(
        cls.hits,
        cls.all_hits,
        validations,
        opts,
        finish_reason,
        cls.capped,
    )
    gate = opts.get("intent_gate")
    gate_mode = gate if gate in ("strict", "off") else "block"

    min_confidence = opts.get("min_confidence", 0)
    if not isinstance(min_confidence, (int, float)) or isinstance(min_confidence, bool):
        min_confidence = 0
    min_confidence = max(0.0, min(1.0, min_confidence))
    recovery_envelopes = [
        envelope
        for index, envelope in enumerate(cls.envelopes)
        if validations[index].structurally_valid and not intent.per_envelope[index].blocked
    ]
    recovered_calls = [ToolCall(name=e.name, arguments=e.arguments) for e in recovery_envelopes]
    recovered = (
        cls.pattern != "C"
        and len(recovered_calls) > 0
        and confidence >= min_confidence
        and (not opts.get("strict_schema") or all_schemas_valid)
    )

    partial_recovery: List[str] = []
    if recovered and 0 < len(recovered_calls) < len(cls.envelopes):
        partial_recovery = [
            "recovered {} of {} candidate envelopes (blocked ones are listed above)".format(
                len(recovered_calls), len(cls.envelopes)
            )
        ]
    planning_warning: List[str] = []
    if gate_mode == "block" and intent.planning_cues:
        planning_warning = [
            'planning language detected near the envelope ("{}") — not blocking in the default gate; see docs/intent-guard.md'.format(
                intent.planning_cues[0]
            )
        ]
    finish_warning: List[str] = []
    if gate_mode != "off" and finish_reason == "length":
        finish_warning = [
            'finish_reason "length": the response may have been truncated — verify the recovered envelope is complete'
        ]

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
        warnings=(
            cls.reasons
            + conf_warnings
            + ([] if all_structurally_valid else ["recovery blocked: recovered envelope is not structurally valid"])
            + ([] if confidence >= min_confidence else ["recovery blocked: confidence {:.2f} is below minConfidence {:.2f}".format(confidence, min_confidence)])
            + ([] if not opts.get("strict_schema") or all_schemas_valid else ["recovery blocked: strictSchema requires valid supplied tool schema for every recovered call"])
            + intent.evidence.blocked
            + partial_recovery
            + planning_warning
            + finish_warning
        ),
        validation=validation,
        recovered_response=None,
        category=intent.category,
        intent=intent.evidence,
        recovered_calls=recovered_calls if recovered else None,
    )


def confidence_input(cls, matrix_match, engine: str, version, validation):
    from .confidence import ConfidenceInput

    return ConfidenceInput(
        pattern=cls.pattern,
        matrix_match=matrix_match,
        engine_known=engine != "unknown",
        version_known=version is not None,
        detection_only=cls.pattern == "C",
        trailing_text=any(r.startswith("trailing text") for r in cls.reasons),
        arguments_from_string=bool(cls.envelope and cls.envelope.arguments_from_string),
        validation=validation,
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
        from .types import empty_intent

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
            category=None,
            intent=empty_intent(),
            recovered_calls=None,
        )

    finish_reason = choices[0].get("finish_reason")
    if not isinstance(finish_reason, str):
        finish_reason = None
    result = check_message(choices[0]["message"], finish_reason, **opts)
    if result.recovered and result.recovered_calls:
        result.recovered_response = apply_recovery_many(
            response, [{"name": t.name, "arguments": t.arguments} for t in result.recovered_calls]
        )
    return result
