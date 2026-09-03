import asyncio
import unittest

from unswallow import StreamAccumulator, check_and_rescue_stream


def chunk(delta, finish_reason=None):
    return {
        "id": "chatcmpl-stream",
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "finish_reason": finish_reason, "delta": delta}],
    }


async def it(chunks):
    for c in chunks:
        yield c


class StreamTest(unittest.TestCase):
    def test_envelope_split_across_deltas(self):
        chunks = [
            chunk({"reasoning": "< thin"}),
            chunk({"reasoning": "king>\nI need the weather for "}),
            chunk({"reasoning": "Tokyo.\n<tool_ca"}),
            chunk({"reasoning": 'll>\n{"name": "get_w'}),
            chunk({"reasoning": 'eather", "arguments": {"ci'}),
            chunk({"reasoning": 'ty": "Tokyo"}}\n</tool_'}),
            chunk({"reasoning": "call>\n< respo"}),
            chunk({"reasoning": "nse>\n"}),
            chunk({"content": ""}, "stop"),
        ]

        async def run():
            return await check_and_rescue_stream(
                it(chunks), engine_hint="vllm", engine_version="0.19.0"
            )

        result = asyncio.run(run())
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertTrue(result.recovered)
        self.assertEqual(result.confidence, 0.95)
        self.assertEqual(result.tool_call.name, "get_weather")
        self.assertEqual(result.tool_call.arguments, {"city": "Tokyo"})
        self.assertEqual(result.recovered_response["choices"][0]["finish_reason"], "tool_calls")
        calls = result.recovered_response["choices"][0]["message"]["tool_calls"]
        self.assertEqual(calls[0]["function"]["name"], "get_weather")

    def test_whole_envelope_in_one_delta(self):
        chunks = [
            chunk(
                {
                    "reasoning": (
                        "< thinking>\n"
                        '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Oslo"}}\n'
                        "</tool_call>\n< response>\n"
                    )
                }
            ),
            chunk({}, "stop"),
        ]

        async def run():
            return await check_and_rescue_stream(it(chunks), engine_hint="vllm", engine_version="0.19.0")

        result = asyncio.run(run())
        self.assertTrue(result.detected)
        self.assertEqual(result.tool_call.arguments, {"city": "Oslo"})

    def test_pattern_b_streaming(self):
        chunks = [
            chunk({"content": '{"name": "get_weather", "arguments": {"city": "Bei'}),
            chunk({"content": 'jing"}}'}),
            chunk({"content": "\n\nLet me also check whether anything else is relevant to report."}),
            chunk({}, "stop"),
        ]

        async def run():
            return await check_and_rescue_stream(it(chunks))

        result = asyncio.run(run())
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "B")
        self.assertEqual(result.tool_call.arguments, {"city": "Beijing"})

    def test_pattern_c_leak_on_leak_and_end(self):
        leaks = []
        chunks = [
            chunk({"content": "Here is the summary. <mm:thi"}),
            chunk({"content": "nk>I should verify the weather data first"}),
            chunk({}, "stop"),
        ]

        async def run():
            return await check_and_rescue_stream(it(chunks), on_leak=leaks.append)

        result = asyncio.run(run())
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "C")
        self.assertFalse(result.recovered)
        self.assertLessEqual(result.confidence, 0.5)
        self.assertTrue(leaks)

    def test_healthy_streamed_tool_call_untouched(self):
        chunks = [
            chunk({"reasoning": "< thinking>\nI will call get_weather.\n< response>\n"}),
            chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_abc",
                            "type": "function",
                            "function": {"name": "get_weather", "arguments": '{"city":'},
                        }
                    ]
                }
            ),
            chunk({"tool_calls": [{"index": 0, "function": {"arguments": ' "Rome"}'}}]}),
            chunk({}, "tool_calls"),
        ]

        async def run():
            return await check_and_rescue_stream(it(chunks), engine_hint="vllm", engine_version="0.24.0")

        result = asyncio.run(run())
        self.assertFalse(result.detected)
        self.assertEqual(result.confidence, 0.0)
        self.assertIsNone(result.recovered_response)

    def test_buffer_guard(self):
        acc = StreamAccumulator(max_buffer_bytes=64)
        with self.assertRaises(ValueError):
            acc.push(chunk({"content": "x" * 100}))

    def test_finish_reason_upgrade(self):
        chunks = [
            chunk(
                {
                    "reasoning": (
                        "< thinking>\n"
                        '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Kyoto"}}\n'
                        "</tool_call>\n< response>\n"
                    )
                }
            ),
            chunk({}, "stop"),
        ]

        async def run():
            return await check_and_rescue_stream(it(chunks), engine_hint="llama.cpp", engine_version="b8461")

        result = asyncio.run(run())
        self.assertTrue(result.recovered)
        self.assertEqual(result.recovered_response["choices"][0]["finish_reason"], "tool_calls")
        self.assertEqual(result.confidence, 0.95)

    def test_accumulator_preserves_id_model_channels(self):
        acc = StreamAccumulator()
        acc.push({"id": "chatcmpl-42", "model": "Qwen3.5-35B-A3B-FP8", "choices": [{"delta": {"reasoning": "< thinking>\n"}}]})
        acc.push({"id": "chatcmpl-42", "model": "Qwen3.5-35B-A3B-FP8", "choices": [{"delta": {"reasoning": "hello"}}]})
        acc.push({"choices": [{"delta": {"content": "answer"}}]})
        response = acc.end()
        self.assertEqual(response["id"], "chatcmpl-42")
        self.assertEqual(response["model"], "Qwen3.5-35B-A3B-FP8")
        self.assertEqual(response["choices"][0]["message"]["reasoning"], "< thinking>\nhello")
        self.assertEqual(response["choices"][0]["message"]["content"], "answer")
        self.assertEqual(response["choices"][0]["finish_reason"], "stop")

    def test_parallel_calls_split_across_deltas(self):
        chunks = [
            chunk({"reasoning": "< thinking>\nTwo parallel searches.\n<tool_call>{\"name\": \"se"}),
            chunk({"reasoning": 'arch", "arguments": {"query": "one"}}</tool_call>\n<tool_ca'}),
            chunk({"reasoning": 'll>{"name": "search", "arguments": {"query": "two"}}</tool_call>\n< res'}),
            chunk({"reasoning": "ponse>\n"}),
            chunk({}, "stop"),
        ]

        async def run():
            return await check_and_rescue_stream(it(chunks), engine_hint="vllm", engine_version="0.19.0")

        result = asyncio.run(run())
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertTrue(result.recovered)
        self.assertEqual(
            [(t.name, t.arguments) for t in result.tool_calls],
            [("search", {"query": "one"}), ("search", {"query": "two"})],
        )
        calls = result.recovered_response["choices"][0]["message"]["tool_calls"]
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()