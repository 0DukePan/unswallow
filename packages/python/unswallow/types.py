from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

EngineId = Literal["vllm", "sglang", "llama.cpp"]
ToolPattern = Literal["A", "B", "C", "D"]
ChannelSource = Literal["reasoning", "reasoning_content", "thinking", "thought", "content"]


@dataclass
class ToolCall:
    name: str
    arguments: Dict[str, Any]


@dataclass
class ToolEnvelope:
    name: str
    arguments: Dict[str, Any]
    raw: str
    format: str
    arguments_from_string: bool = False
    start: int = -1
    end: int = -1


@dataclass
class SwallowMatrixEntry:
    version_range: str = "*"
    pattern: str = "A"
    behavior: str = "swallow"
    verified: bool = False
    known_behavior: str = ""
    source: str = ""
    engine: Optional[str] = None
    harness: Optional[str] = None
    model_families: Optional[List[str]] = None
    fix_hint: Optional[str] = None

    @classmethod
    def from_json(cls, row: Dict[str, Any]) -> "SwallowMatrixEntry":
        return cls(
            engine=row.get("engine"),
            harness=row.get("harness"),
            version_range=row.get("versionRange", "*"),
            pattern=row.get("pattern", "A"),
            model_families=row.get("modelFamilies"),
            behavior=row.get("behavior", "swallow"),
            verified=row.get("verified", False),
            known_behavior=row.get("knownBehavior", ""),
            source=row.get("source", ""),
            fix_hint=row.get("fixHint"),
        )


@dataclass
class SwallowCheckResult:
    detected: bool
    pattern: Optional[str]
    tool_call: Optional[ToolCall]
    tool_calls: Optional[List[ToolCall]]
    recovered: bool
    source: str
    engine_hint: str
    matrix_match: Optional[SwallowMatrixEntry]
    confidence: float
    warnings: List[str] = field(default_factory=list)
    recovered_response: Optional[Dict[str, Any]] = None


def not_detected(engine_hint: str) -> SwallowCheckResult:
    return SwallowCheckResult(
        detected=False,
        pattern=None,
        tool_call=None,
        tool_calls=None,
        recovered=False,
        source="content",
        engine_hint=engine_hint,
        matrix_match=None,
        confidence=0.0,
        warnings=[],
        recovered_response=None,
    )