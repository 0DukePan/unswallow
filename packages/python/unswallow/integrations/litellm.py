"""LiteLLM callback that detects reasoning-channel swallows.

``litellm`` is imported lazily: installing ``unswallow`` never pulls litellm
in. Wire it up after creating your litellm client::

    import litellm
    from unswallow.integrations.litellm import make_swallow_logger

    logger = make_swallow_logger(on_detect=lambda message, calls: print(
        f\"swallowed tool call(s) recovered: {[c['name'] for c in calls]}\"))
    litellm.callbacks.append(logger)

The callback detects and reports; it does not rewrite the response in place
(pydantic models are not safely mutable here). For in-place recovery use the
proxy mode. The detection core (:func:`check_message_dict`) is pure and
unit-tested without litellm installed.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from ..pipeline import check_and_rescue

OnDetect = Callable[[Dict[str, Any], List[Dict[str, Any]]], None]


def check_message_dict(message: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
    """Run detection+recovery on a single message dict.

    Returns the recovered tool calls (name + parsed arguments) when a
    structurally complete swallowed envelope was found and recovered, else
    ``None``. Pure and testable without litellm.
    """
    if not isinstance(message, dict):
        return None
    result = check_and_rescue(
        {"choices": [{"index": 0, "finish_reason": "stop", "message": message}]}
    )
    if result.detected and result.recovered and result.tool_calls:
        return [{"name": c.name, "arguments": c.arguments} for c in result.tool_calls]
    return None


def _message_to_dict(message: Any) -> Optional[Dict[str, Any]]:
    """Coerce a litellm response message (pydantic or plain dict) to a dict."""
    if isinstance(message, dict):
        return message
    dump = getattr(message, "model_dump", None)
    if callable(dump):
        return dump()
    return None


def make_swallow_logger(on_detect: Optional[OnDetect] = None) -> Any:
    """Build a configured ``litellm.integrations.custom_logger.CustomLogger``.

    Returns ``None`` if litellm is not installed (so the integration can be
    enabled unconditionally in app startup code). The returned object fires
    ``on_detect(message_dict, recovered_calls)`` for every completion or
    streaming response that carried a swallowed, recoverable tool call.
    """
    try:
        from litellm.integrations.custom_logger import CustomLogger  # type: ignore[import-not-found]
    except ImportError:
        return None

    class SwallowLogger(CustomLogger):
        def __init__(self) -> None:
            super().__init__()

        def log_success_event(self, kwargs: Any, response_obj: Any, start_time: Any, end_time: Any) -> None:
            self._check(response_obj)

        async def async_log_success_event(self, kwargs: Any, response_obj: Any, start_time: Any, end_time: Any) -> None:
            self._check(response_obj)

        def _check(self, response_obj: Any) -> None:
            if on_detect is None:
                return
            choices = getattr(response_obj, "choices", None)
            if not choices:
                return
            for choice in choices:
                message = _message_to_dict(getattr(choice, "message", None))
                if message is None:
                    continue
                calls = check_message_dict(message)
                if calls:
                    on_detect(message, calls)

    return SwallowLogger()
