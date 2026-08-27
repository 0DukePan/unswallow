import unittest

from unswallow import check_and_rescue, match_matrix_entry, normalize_engine


def response(message, finish_reason="stop"):
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "model": "test-model",
        "choices": [{"index": 0, "finish_reason": finish_reason, "message": message}],
    }


class CoreTest(unittest.TestCase):
    def test_pattern_a_function_xml_in_reasoning(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\nI need to answer the user\u2019s question. The answer is 204.\n"
                    "<tool_call>\n<function=Finish>\n<parameter=answer>\n204\n</parameter>\n</function>\n"
                    "</tool_call>\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertEqual(result.source, "reasoning")
        self.assertTrue(result.recovered)
        self.assertEqual(result.confidence, 0.95)
        self.assertEqual(result.tool_call.name, "Finish")
        self.assertEqual(result.tool_call.arguments, {"answer": 204})
        self.assertIsNotNone(result.recovered_response)
        calls = result.recovered_response["choices"][0]["message"]["tool_calls"]
        self.assertEqual(calls[0]["function"]["name"], "Finish")
        self.assertEqual(calls[0]["function"]["arguments"], '{"answer": 204}')
        self.assertEqual(result.recovered_response["choices"][0]["finish_reason"], "tool_calls")

    def test_pattern_a_json_envelope_in_reasoning_content(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": (
                    "< thinking>\nI should get the weather for Tokyo.\n"
                    '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="sglang", engine_version="0.4.6")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertEqual(result.source, "reasoning_content")
        self.assertEqual(result.tool_call.arguments, {"city": "Tokyo"})
        self.assertEqual(result.confidence, 0.95)

    def test_pattern_a_think_block_in_content(self):
        r = response(
            {
                "role": "assistant",
                "content": (
                    "<thinking>\nThe user wants the weather in Berlin.\n"
                    '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Berlin"}}\n</tool_call>\n'
                    "</thinking>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="llama.cpp", engine_version="b8461")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertEqual(result.source, "thinking")
        self.assertEqual(result.tool_call.arguments, {"city": "Berlin"})
        self.assertEqual(result.confidence, 0.95)

    def test_pattern_b_trailing_text(self):
        r = response(
            {
                "role": "assistant",
                "content": (
                    '{"name": "get_weather", "arguments": {"city": "Beijing"}}\n\n'
                    "Let me also check whether there is any other useful information to report.\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="llama.cpp", engine_version="b8461")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "B")
        self.assertEqual(result.source, "content")
        self.assertTrue(result.recovered)
        self.assertEqual(result.confidence, 0.55)
        self.assertTrue(any(w.startswith("trailing text") for w in result.warnings))

    def test_pattern_b_complete_json_in_content(self):
        r = response(
            {
                "role": "assistant",
                "content": '{"name": "get_weather", "arguments": {"city": "Paris"}}',
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.26.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "B")
        self.assertTrue(result.recovered)

    def test_pattern_c_leak_detection_only(self):
        r = response(
            {
                "role": "assistant",
                "content": "Here is the answer. <mm:think>I should verify the weather data first",
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r)
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "C")
        self.assertFalse(result.recovered)
        self.assertLessEqual(result.confidence, 0.5)

    def test_healthy_response_untouched(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": "< thinking>\nI will call get_weather.\n< response>\n",
                "tool_calls": [
                    {
                        "id": "call_abc",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city": "Tokyo"}'},
                    }
                ],
            },
            "tool_calls",
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.24.0")
        self.assertFalse(result.detected)
        self.assertEqual(result.confidence, 0.0)
        self.assertIsNone(result.recovered_response)

    def test_resolved_range_warns(self):
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
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.25.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.confidence, 0.6)
        self.assertIsNotNone(result.matrix_match)
        self.assertEqual(result.matrix_match.behavior, "resolved")
        self.assertTrue(any("resolved" in w for w in result.warnings))

    def test_unknown_engine_heuristic(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '{"name": "get_weather", "arguments": {"city": "Rome"}}\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r)
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertEqual(result.confidence, 0.55)
        self.assertEqual(result.engine_hint, "unknown")
        self.assertIsNone(result.matrix_match)
        self.assertTrue(any("engine_hint" in w for w in result.warnings))

    def test_tool_schemas_mismatch_lowers_confidence(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '{"name": "get_weather", "arguments": {"city": "Oslo"}}\n'
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
                    "function": {"name": "get_news", "parameters": {"type": "object", "properties": {}}},
                }
            ],
        )
        self.assertEqual(result.confidence, 0.85)
        self.assertTrue(any("not found in provided tool_schemas" in w for w in result.warnings))

    def test_missing_choices(self):
        result = check_and_rescue({"choices": []})
        self.assertFalse(result.detected)
        self.assertEqual(result.confidence, 0.0)
        self.assertTrue(result.warnings)

    def test_normalize_engine(self):
        self.assertEqual(normalize_engine("vllm"), "vllm")
        self.assertEqual(normalize_engine("sglang"), "sglang")
        self.assertEqual(normalize_engine("llama.cpp"), "llama.cpp")
        self.assertEqual(normalize_engine("llama-cpp"), "llama.cpp")
        self.assertEqual(normalize_engine("LLAMA.CPP"), "llama.cpp")
        self.assertEqual(normalize_engine("anything-else"), "unknown")
        self.assertEqual(normalize_engine(None), "unknown")


if __name__ == "__main__":
    unittest.main()