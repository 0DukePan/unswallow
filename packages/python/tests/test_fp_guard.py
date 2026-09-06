import unittest

from unswallow import check_and_rescue


def response(message):
    return {
        "id": "chatcmpl-fp",
        "object": "chat.completion",
        "model": "test-model",
        "choices": [{"index": 0, "finish_reason": "stop", "message": message}],
    }


class FpGuardTest(unittest.TestCase):
    def test_discussion_only_never_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\nI could call get_weather to check the weather in Tokyo, but I do not "
                    "need it for this answer. The user only asked a general question.\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)
        self.assertEqual(result.confidence, 0.0)
        self.assertIsNone(result.recovered_response)

    def test_partial_json_without_arguments(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\nI might call {\"name\": \"get_weather\" if needed.\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)

    def test_non_object_arguments_rejected(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '<tool_call>\n{"name": "get_weather", "arguments": "Tokyo"}\n</tool_call>\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)

    def test_missing_name_rejected(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '<tool_call>\n{"arguments": {"city": "Tokyo"}}\n</tool_call>\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)

    def test_unclosed_xml_with_broken_json_rejected(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\nI wonder if <tool_call>\n"
                    '{"name": "get_weather", "arguments": {"city": "Tokyo"}\n'
                    "is the right thing to do.\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)

    def test_empty_name_function_rejected(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n<function=>\n<parameter=answer>204</parameter>\n</function>\n"
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)

    def test_real_recovery_with_matching_schema(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(
            r,
            engine_hint="vllm",
            engine_version="0.19.0",
            tool_schemas=[
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "parameters": {
                            "type": "object",
                            "properties": {"city": {"type": "string"}},
                            "required": ["city"],
                        },
                    },
                }
            ],
        )
        self.assertTrue(result.detected)
        self.assertEqual(result.confidence, 0.95)
        self.assertEqual(result.tool_call.arguments, {"city": "Tokyo"})


if __name__ == "__main__":
    unittest.main()
