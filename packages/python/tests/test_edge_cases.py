import unittest

from unswallow import check_and_rescue, sanitize_history, strip_reasoning_tags

VLLM = {"engine_hint": "vllm", "engine_version": "0.19.0"}


def response(message, finish_reason="stop"):
    return {
        "id": "chatcmpl-edges",
        "object": "chat.completion",
        "model": "test-model",
        "choices": [{"index": 0, "finish_reason": finish_reason, "message": message}],
    }


class ParsingEdgesTest(unittest.TestCase):
    def test_escaped_newline_in_arguments_survives(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n<tool_call>\n"
                    '{"name": "log_note", "arguments": {"note": "line1\\nline2"}}\n'
                    "</tool_call>\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, **VLLM)
        self.assertTrue(result.detected)
        self.assertEqual(result.tool_call.arguments, {"note": "line1\nline2"})

    def test_non_ascii_whitespace_preserved(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n<tool_call>\n"
                    '{"name": "edit", "arguments": {"text": "a\u00a0b\u2003c"}}\n'
                    "</tool_call>\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, **VLLM)
        self.assertTrue(result.detected)
        self.assertEqual(result.tool_call.arguments, {"text": "a\u00a0b\u2003c"})

    def test_whitespace_padded_envelope_recovered(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "< thinking>\n  \n\t<tool_call>\n   \n"
                    '{"name": "get_weather", "arguments": {"city": "Osaka"}}\n   \n'
                    "</tool_call>\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, **VLLM)
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")

    def test_whitespace_only_content_is_absent(self):
        r = response(
            {
                "role": "assistant",
                "content": "   \n\t ",
                "reasoning": (
                    "< thinking>\n<tool_call>\n"
                    '{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n'
                    "</tool_call>\n< response>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, **VLLM)
        self.assertTrue(result.detected)
        self.assertTrue(result.recovered)

    def test_missing_content_key_no_crash(self):
        r = response(
            {
                "role": "assistant",
                "reasoning": (
                    "<thinking>\n<tool_call>\n"
                    '{"name": "get_weather", "arguments": {"city": "Kyoto"}}\n'
                    "</tool_call>\n</thinking>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, **VLLM)
        self.assertTrue(result.detected)
        self.assertTrue(result.recovered)
        self.assertEqual(result.tool_call.arguments, {"city": "Kyoto"})

    def test_multiple_envelopes_mixed_channels(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "reasoning": (
                    "<thinking>\n<tool_call>\n"
                    '{"name": "search", "arguments": {"q": "alpha"}}\n'
                    "</tool_call>\n<tool_call>\n"
                    '{"name": "search", "arguments": {"q": "beta"}}\n'
                    "</tool_call>\n</thinking>\n"
                ),
                "reasoning_content": (
                    "<thinking>\n<function=get_weather>\n<parameter=city>Nara</parameter>\n"
                    "</function>\n</thinking>\n"
                ),
                "tool_calls": [],
            }
        )
        result = check_and_rescue(r, **VLLM)
        self.assertTrue(result.detected)
        self.assertEqual(len(result.tool_calls), 3)
        self.assertEqual([c.name for c in result.tool_calls], ["search", "search", "get_weather"])


class StreamingEdgesTest(unittest.TestCase):
    def test_reasoning_interleaved_with_empty_and_non_string_deltas(self):
        import asyncio

        from unswallow import check_and_rescue_stream

        chunks = [
            {"id": "chatcmpl-e", "model": "m", "choices": [{"index": 0, "finish_reason": None, "delta": {"reasoning": "< think"}}]},
            {"choices": [{"index": 0, "finish_reason": None, "delta": {}}]},
            {"choices": [{"index": 0, "finish_reason": None, "delta": {"reasoning": "ing>\n"}}]},
            {"choices": [{"index": 0, "finish_reason": None, "delta": {"reasoning": None}}]},
            {"choices": [{"index": 0, "finish_reason": None, "delta": {"reasoning": 42}}]},
            {"choices": [{"index": 0, "finish_reason": None, "delta": {"content": ""}}]},
            {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": None,
                        "delta": {
                            "reasoning": '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n'
                        },
                    }
                ]
            },
            {"choices": [{"index": 0, "finish_reason": "stop", "delta": {}}]},
        ]

        async def run():
            return await check_and_rescue_stream(_iter(chunks), **VLLM)

        result = asyncio.run(run())
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertTrue(result.recovered)
        self.assertEqual(result.tool_call.name, "get_weather")

    def test_single_delta_envelope_not_double_counted(self):
        import asyncio

        from unswallow import check_and_rescue_stream

        chunks = [
            {"id": "chatcmpl-e2", "model": "m", "choices": [{"index": 0, "finish_reason": None, "delta": {"content": ""}}]},
            {"choices": [{"index": 0, "finish_reason": None, "delta": {"content": ""}}]},
            {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": None,
                        "delta": {
                            "reasoning": "<thinking>\nI will search.\n<tool_call>\n"
                            '{"name": "search", "arguments": {"q": "x"}}\n'
                            "</tool_call>\n</thinking>\n"
                        },
                    }
                ]
            },
            {"choices": [{"index": 0, "finish_reason": "stop", "delta": {}}]},
        ]

        async def run():
            return await check_and_rescue_stream(_iter(chunks), **VLLM)

        result = asyncio.run(run())
        self.assertTrue(result.recovered)
        self.assertEqual(len(result.tool_calls), 1)

    def test_healthy_streamed_tool_calls_untouched(self):
        import asyncio

        from unswallow import check_and_rescue_stream

        chunks = [
            {
                "id": "chatcmpl-e3",
                "model": "m",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": None,
                        "delta": {
                            "tool_calls": [
                                {"index": 0, "id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": ""}}
                            ]
                        },
                    }
                ],
            },
            {
                "choices": [
                    {"index": 0, "finish_reason": None, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"city":"Osaka"}'}}]}}
                ]
            },
            {"choices": [{"index": 0, "finish_reason": "tool_calls", "delta": {}}]},
        ]

        async def run():
            return await check_and_rescue_stream(_iter(chunks), engine_hint="vllm", engine_version="0.24.0")

        result = asyncio.run(run())
        self.assertFalse(result.detected)
        self.assertFalse(result.recovered)


class HistoryEdgesTest(unittest.TestCase):
    def test_missing_tool_result_preserved(self):
        history = [
            {"role": "user", "content": "weather?"},
            {
                "role": "assistant",
                "content": "",
                "reasoning": "< thinking>\nplan\n< response>\n",
                "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"Tokyo"}'}}
                ],
            },
        ]
        clean = sanitize_history(history)
        self.assertEqual(len(clean), 2)
        self.assertEqual(len(clean[1]["tool_calls"]), 1)
        self.assertEqual(clean[1]["tool_calls"][0]["function"]["name"], "get_weather")
        self.assertNotIn("reasoning", clean[1])

    def test_broken_function_entry_survives(self):
        history = [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{bad json"}}],
            },
            {"role": "tool", "content": "no result"},
            {"role": "user", "content": "again"},
        ]
        clean = sanitize_history(history)
        self.assertEqual(len(clean), 3)
        self.assertEqual(
            clean[0]["tool_calls"],
            [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{bad json"}}],
        )

    def test_strip_block_with_answer_on_same_line(self):
        self.assertEqual(strip_reasoning_tags("<thinking>\nshort plan\n</thinking>The weather is 24C."), "The weather is 24C.")

    def test_strip_unicode_reasoning(self):
        self.assertEqual(strip_reasoning_tags("<thinking>\n日本語で計画する 計画\n</thinking>\n答え：24度"), "答え：24度")

    def test_empty_tool_name_does_not_crash(self):
        r = response(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call_x", "type": "function", "function": {"name": "", "arguments": "{}"}}],
            },
            "tool_calls",
        )
        result = check_and_rescue(r, **VLLM)
        self.assertFalse(result.detected)
        self.assertFalse(result.recovered)


async def _iter(chunks):
    for c in chunks:
        yield c


if __name__ == "__main__":
    unittest.main()
