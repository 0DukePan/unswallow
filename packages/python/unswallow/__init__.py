from __future__ import annotations

from .history import sanitize_history, strip_reasoning_tags
from .matrix import (
    get_matrix_file,
    load_matrix,
    match_matrix_entry,
    normalize_engine,
)
from .pipeline import check_and_rescue, check_message
from .recover import (
    apply_recovery_to_response,
    build_tool_calls_entry,
    extract_envelope,
    validate_envelope_shape,
)
from .semver import matches_range, parse_range, parse_version
from .stream import StreamAccumulator, check_and_rescue_stream
from .types import (
    SwallowCheckResult,
    SwallowMatrixEntry,
    ToolCall,
    ToolEnvelope,
)

__version__ = "0.1.0"

__all__ = [
    "check_and_rescue",
    "check_message",
    "check_and_rescue_stream",
    "StreamAccumulator",
    "sanitize_history",
    "strip_reasoning_tags",
    "load_matrix",
    "get_matrix_file",
    "match_matrix_entry",
    "normalize_engine",
    "matches_range",
    "parse_range",
    "parse_version",
    "extract_envelope",
    "validate_envelope_shape",
    "build_tool_calls_entry",
    "apply_recovery_to_response",
    "SwallowCheckResult",
    "SwallowMatrixEntry",
    "ToolCall",
    "ToolEnvelope",
    "__version__",
]