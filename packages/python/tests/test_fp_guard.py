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

    # Adversarial corpus at unit level — the same shapes pinned as the adv-* fixtures.

    def test_complete_envelope_with_negated_language_is_not_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    '< thinking>\nThe model would output {"name": "get_weather", "arguments": '
                    '{"city": "Tokyo"}}\nDo not execute this — illustrative only.\n< response>\n'
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "quoted_tool_call")
        self.assertFalse(result.recovered)

    def test_mid_reasoning_envelope_is_a_rehearsal(self):
        prose = (
            "Pulling live weather is not necessary for a packing list, and the user did not ask for current "
            "conditions. I will explain seasonal expectations instead and keep the answer concise."
        )
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\nLet me weigh the options.\n"
                    '{"name": "get_weather", "arguments": {"city": "Lisbon"}}\n'
                    + prose
                    + "\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "tool_rehearsal")
        self.assertFalse(result.recovered)

    def test_retracted_call_is_not_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    '< thinking>\n{"name": "get_weather", "arguments": {"city": "Cairo"}}\n'
                    "Actually, no — scratch that. I will answer directly instead.\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "tool_rehearsal")
        self.assertFalse(result.recovered)

    def test_mixed_rehearsed_and_genuine_recovers_only_the_terminal_call(self):
        prose = (
            "That was only a draft of what the call might look like, and after reconsidering the user request I "
            "will now decide on the final approach and continue carefully."
        )
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\nWorking through options.\n"
                    '{"name": "get_weather", "arguments": {"city": "Oslo"}}\n'
                    + prose
                    + '\n{"name": "get_weather", "arguments": {"city": "Kyoto"}}\n< response>\n'
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.recovered)
        self.assertEqual(len(result.recovered_calls), 1)
        self.assertEqual(result.recovered_calls[0].arguments, {"city": "Kyoto"})

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
