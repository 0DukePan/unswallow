import asyncio
import re
import unittest

from unswallow import check_and_rescue_stream

STREAM_TEXT = (
    "< thinking>\nI need the weather for Tokyo.\n<tool_call>\n"
    '{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n'
    "</tool_call>\n< response>\n"
)


def chunk(delta, finish_reason=None):
    return {
        "id": "chatcmpl-sweep",
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "finish_reason": finish_reason, "delta": delta}],
    }


async def it(chunks):
    for c in chunks:
        yield c


async def run(chunks, **opts):
    return await check_and_rescue_stream(it(chunks), **opts)


def stream_split_at(offsets):
    out = []
    prev = 0
    for off in list(offsets) + [len(STREAM_TEXT)]:
        piece = STREAM_TEXT[prev:off]
        prev = off
        if piece:
            out.append(chunk({"reasoning": piece}))
    out.append(chunk({}, "stop"))
    return out


class StreamSweepTest(unittest.TestCase):
    def test_single_char_splits_recover_identically(self):
        reference = asyncio.run(
            run([chunk({"reasoning": STREAM_TEXT}), chunk({}, "stop")], engine_hint="vllm", engine_version="0.19.0")
        )
        self.assertTrue(reference.detected)
        for i in range(1, len(STREAM_TEXT)):
            result = asyncio.run(
                run(stream_split_at([i]), engine_hint="vllm", engine_version="0.19.0")
            )
            self.assertTrue(result.detected, "split at {} must detect".format(i))
            self.assertEqual(result.pattern, "A", "split at {} must classify A".format(i))
            self.assertTrue(result.recovered, "split at {} must recover".format(i))
            self.assertEqual(
                (result.tool_call.name, result.tool_call.arguments),
                ("get_weather", {"city": "Tokyo"}),
                "split at {} must recover the same call".format(i),
            )
            self.assertEqual(
                result.recovered_response["choices"][0]["finish_reason"],
                "tool_calls",
                "split at {} finish_reason".format(i),
            )

    def test_two_char_splits_recover_identically(self):
        reference = asyncio.run(
            run([chunk({"reasoning": STREAM_TEXT}), chunk({}, "stop")], engine_hint="vllm", engine_version="0.19.0")
        )
        for i in range(1, len(STREAM_TEXT) - 1):
            result = asyncio.run(
                run(stream_split_at([i, i + 2]), engine_hint="vllm", engine_version="0.19.0")
            )
            self.assertTrue(result.detected, "split at {},{} must detect".format(i, i + 2))
            self.assertEqual(result.pattern, "A", "split at {},{} must classify A".format(i, i + 2))
            self.assertEqual(
                (result.tool_call.name, result.tool_call.arguments),
                (reference.tool_call.name, reference.tool_call.arguments),
                "split at {},{} must recover the same call".format(i, i + 2),
            )
            self.assertEqual(
                result.recovered_response["choices"][0]["finish_reason"],
                "tool_calls",
                "split at {},{} finish_reason".format(i, i + 2),
            )

    def test_tag_boundary_splits_recover_identically(self):
        boundaries = [0]
        for i in range(len(STREAM_TEXT) - 1):
            if STREAM_TEXT[i] == "<" and STREAM_TEXT[i + 1].isalpha():
                boundaries.append(i)
        boundaries.append(len(STREAM_TEXT))
        reference = asyncio.run(
            run([chunk({"reasoning": STREAM_TEXT}), chunk({}, "stop")], engine_hint="vllm", engine_version="0.19.0")
        )
        for i in range(1, len(boundaries) - 1):
            result = asyncio.run(
                run(stream_split_at([boundaries[i]]), engine_hint="vllm", engine_version="0.19.0")
            )
            self.assertTrue(result.detected, "boundary split at {} must detect".format(boundaries[i]))
            self.assertTrue(result.recovered, "boundary split at {} must recover".format(boundaries[i]))
            self.assertEqual(
                (result.tool_call.name, result.tool_call.arguments),
                (reference.tool_call.name, reference.tool_call.arguments),
                "boundary split at {}".format(boundaries[i]),
            )

    def test_token_scale_splits_reconstruct(self):
        pieces = re.findall(r".{1,8}", STREAM_TEXT, flags=re.S)
        chunks = [chunk({"reasoning": p}) for p in pieces]
        chunks.append(chunk({}, "stop"))
        result = asyncio.run(run(chunks, engine_hint="vllm", engine_version="0.19.0"))
        self.assertTrue(result.detected)
        self.assertTrue(result.recovered)
        self.assertEqual(result.tool_call.arguments, {"city": "Tokyo"})

    def test_interleaved_empty_deltas_ignored(self):
        chunks = [
            chunk({"reasoning": '< thinking>\n<tool_call>\n{"name": "get_'}),
            chunk({}),
            chunk({"content": ""}),
            chunk({"reasoning": 'weather", "arguments": {"city": "Lima"}}\n</tool_call>\n< response>\n'}),
            chunk({}, "stop"),
        ]
        result = asyncio.run(run(chunks, engine_hint="vllm", engine_version="0.19.0"))
        self.assertTrue(result.detected)
        self.assertEqual(result.pattern, "A")
        self.assertEqual(result.tool_call.arguments, {"city": "Lima"})


if __name__ == "__main__":
    unittest.main()
