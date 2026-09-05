import unittest

from unswallow import check_and_rescue

ENVELOPE = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>'


def response(message, finish_reason="stop"):
    return {
        "id": "chatcmpl-torture",
        "object": "chat.completion",
        "model": "test-model",
        "choices": [{"index": 0, "finish_reason": finish_reason, "message": message}],
    }


class TortureTest(unittest.TestCase):
    def test_unicode_arguments_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '<tool_call>\n{"name": "get_weather", "arguments": {"city": "\u6771\u4eac\u90fd", '
                    '"note": "\u65e5\u672c\u8a9e\u306e\u30c6\u30b9\u30c8 \u2014 emoji \U0001f38c and '
                    '\u4e2d\u6587"}}\n</tool_call>\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertTrue(result.recovered)
        self.assertEqual(
            result.tool_call.arguments,
            {"city": "\u6771\u4eac\u90fd", "note": "\u65e5\u672c\u8a9e\u306e\u30c6\u30b9\u30c8 \u2014 emoji \U0001f38c and \u4e2d\u6587"},
        )
        import json

        parsed = json.loads(result.recovered_response["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"])
        self.assertEqual(parsed["city"], "\u6771\u4eac\u90fd")

    def test_escaped_quotes_and_backslashes_survive(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '<tool_call>\n{"name": "submit", "arguments": {"text": "he said \\"hi\\"", '
                    '"path": "C:\\\\tmp\\\\file.txt"}}\n</tool_call>\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(
            result.tool_call.arguments,
            {"text": 'he said "hi"', "path": "C:\\tmp\\file.txt"},
        )

    def test_braces_in_string_values_do_not_confuse_scanner(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '<tool_call>\n{"name": "submit", "arguments": {"code": "if (x) { return {ok: 1}; }", '
                    '"msg": "close } brace"}}\n</tool_call>\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertTrue(result.recovered)
        self.assertEqual(result.tool_call.arguments["code"], "if (x) { return {ok: 1}; }")
        self.assertEqual(result.tool_call.arguments["msg"], "close } brace")

    def test_deeply_nested_json_arguments_recovered(self):
        import json

        nested = {
            "name": "dispatch",
            "arguments": {"task": {"steps": [{"type": "a", "cfg": {"x": [1, 2, {"y": "z"}]}}]}},
        }
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": "< thinking>\n<tool_call>\n{}\n</tool_call>\n< response>\n".format(
                    json.dumps(nested)
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.tool_call.name, "dispatch")
        self.assertEqual(result.tool_call.arguments, nested["arguments"])

    def test_empty_string_fields_never_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": "",
                "reasoning_content": "",
                "thinking": "",
                "thought": "",
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)
        self.assertEqual(result.confidence, 0.0)

    def test_null_fields_handled(self):
        r = response(
            {
                "role": "assistant",
                "content": None,
                "reasoning": None,
                "reasoning_content": None,
                "thinking": None,
                "thought": None,
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)
        self.assertEqual(result.confidence, 0.0)

    def test_null_tool_calls_still_detected(self):
        r = response(
            {
                "role": "assistant",
                "content": "I checked the weather. {} is what I would use.".format(ENVELOPE),
                "tool_calls": None,
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "B")

    def test_tool_calls_wrong_type_no_crash(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": "< thinking>\n{}\n< response>\n".format(ENVELOPE),
                "tool_calls": "not-an-array",
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")

    def test_missing_content_key_no_crash(self):
        r = response(
            {
                "role": "assistant",
                "reasoning": "< thinking>\n{}\n< response>\n".format(ENVELOPE),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")

    def test_unexpected_provider_fields_do_not_interfere(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": "< thinking>\n{}\n< response>\n".format(ENVELOPE),
                "tool_calls": [],
                "logprobs": {"content": [{"token": "x", "logprob": -0.3}]},
                "annotation": None,
                "extras": {"meta": [1, 2, 3]},
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertEqual(result.recovered_response["choices"][0]["message"]["extras"]["meta"][2], 3)

    def test_additional_fields_scanned(self):
        r = response({"role": "assistant", "content": "", "thought_of": "hmm", "tool_calls": []})
        result = check_and_rescue(
            r,
            engine_hint="vllm",
            engine_version="0.19.0",
            additional_fields=["thought_of"],
        )
        self.assertFalse(result.detected)

        r2 = response(
            {
                "role": "assistant",
                "content": "",
                "thought_of": "< thinking>\n{}\n< response>\n".format(ENVELOPE),
                "tool_calls": [],
            }
        )
        result2 = check_and_rescue(
            r2,
            engine_hint="vllm",
            engine_version="0.19.0",
            additional_fields=["thought_of"],
        )
        self.assertTrue(result2.detected)
        self.assertEqual(result2.pattern, "A")
        self.assertEqual(result2.source, "thought_of")

    def test_json_like_schema_fragment_never_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    'The JSON schema was {"type": "object", "properties": {"city": {"type": "string"}}}. '
                    "I will not call anything.\n"
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)

    def test_truncated_candidate_call_never_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    'To call a tool I would emit {"name": "get_weather", "arguments": {"city": "Oslo" '
                    "but this answer needs no tool \u2014 the object above is only an example.\n"
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)

    def test_arguments_from_string_survive(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n"
                    '<tool_call>\n{"name": "submit", "arguments": "{\\"code\\": \\"if (x) { return; }\\", '
                    '\\"msg\\": \\"hi\\\\nbye\\"}"}\n</tool_call>\n'
                    "< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertTrue(result.recovered)
        self.assertTrue(any("JSON string and were parsed" in w for w in result.warnings))
        self.assertEqual(result.tool_call.arguments, {"code": "if (x) { return; }", "msg": "hi\nbye"})

    def test_long_reasoning_swallow_recovered(self):
        chunk_text = "The weather discussion continues with relevant analysis and numerical estimates for the forecast. "
        reasoning = "< thinking>\n"
        for i in range(300):
            reasoning += chunk_text + str(i) + "\n"
        reasoning += ENVELOPE + "\n"
        for i in range(300):
            reasoning += chunk_text + str(i) + "\n"
        reasoning += "< response>\n"
        r = response({"role": "assistant", "content": "", "reasoning": reasoning, "tool_calls": []})
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertTrue(result.recovered)
        self.assertEqual(result.tool_call.arguments, {"city": "Tokyo"})

    def test_multiple_boundaries_each_envelope_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\nFirst plan.\n"
                    '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Oslo"}}\n</tool_call>\n'
                    "< response>\nI will do that.\n"
                    "< thinking>\nWait, also check Berlin.\n"
                    '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Berlin"}}\n</tool_call>\n'
                    "< response>\nDone.\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertEqual([t.arguments["city"] for t in result.tool_calls], ["Oslo", "Berlin"])

    def test_interleaved_content_envelope_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": (
                    "Here you go.\n"
                    '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Rome"}}\n</tool_call>\n'
                    "Then I will summarize the result for you below.\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "B")
        self.assertTrue(result.recovered)
        self.assertEqual(result.tool_call.arguments["city"], "Rome")


if __name__ == "__main__":
    unittest.main()
