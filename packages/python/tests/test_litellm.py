import unittest

from unswallow.integrations.litellm import check_message_dict, _message_to_dict, make_swallow_logger

SWALLOWED_MESSAGE = {
    "role": "assistant",
    "content": "",
    "reasoning": (
        "< thinking>\nI need the weather.\n"
        '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n'
        "< response>\n"
    ),
    "tool_calls": [],
}

CLEAN_MESSAGE = {
    "role": "assistant",
    "content": "No tools needed.",
    "tool_calls": None,
}


class PydanticLike:
    """Stands in for a litellm pydantic message without requiring litellm."""

    def __init__(self, data):
        self._data = data

    def model_dump(self):
        return self._data


class CheckMessageDictTest(unittest.TestCase):
    def test_detects_and_recovers_swallowed_call(self):
        calls = check_message_dict(SWALLOWED_MESSAGE)
        self.assertIsNotNone(calls)
        self.assertEqual(calls[0]["name"], "get_weather")
        self.assertEqual(calls[0]["arguments"], {"city": "Tokyo"})

    def test_clean_message_is_none(self):
        self.assertIsNone(check_message_dict(CLEAN_MESSAGE))

    def test_non_dict_is_none(self):
        self.assertIsNone(check_message_dict(None))
        self.assertIsNone(check_message_dict("nope"))

    def test_discussion_only_is_none(self):
        self.assertIsNone(
            check_message_dict(
                {
                    "role": "assistant",
                    "content": "",
                    "reasoning": "< thinking>\nI could call get_weather but I won't.\n< response>\n",
                    "tool_calls": [],
                }
            )
        )


class MessageToDictTest(unittest.TestCase):
    def test_passthrough_dict(self):
        self.assertEqual(_message_to_dict(CLEAN_MESSAGE), CLEAN_MESSAGE)

    def test_pydantic_like_model_dump(self):
        self.assertEqual(_message_to_dict(PydanticLike(SWALLOWED_MESSAGE)), SWALLOWED_MESSAGE)

    def test_uncoercible_is_none(self):
        self.assertIsNone(_message_to_dict(42))
        self.assertIsNone(_message_to_dict(object()))


class MakeLoggerTest(unittest.TestCase):
    def test_returns_none_without_litellm_or_constructs(self):
        # Either litellm is installed (a logger is built) or it is not (None).
        # Both are valid; the point is the factory never raises on import.
        try:
            logger = make_swallow_logger()
        except Exception as exc:  # pragma: no cover
            self.fail("make_swallow_logger raised: {}".format(exc))
        if logger is not None:
            self.assertTrue(hasattr(logger, "log_success_event"))
            self.assertTrue(hasattr(logger, "async_log_success_event"))


if __name__ == "__main__":
    unittest.main()