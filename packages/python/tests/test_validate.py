import json
import unittest

from unswallow import check_and_rescue, validate_envelope
from unswallow.types import ToolEnvelope


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}, "units": {"enum": ["c", "f"]}},
                "required": ["city"],
                "additionalProperties": False,
            },
        },
    }
]


def envelope(arguments):
    return ToolEnvelope("get_weather", arguments, "", "json")


def response(arguments):
    call = json.dumps({"name": "get_weather", "arguments": arguments})
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [],
                    "reasoning": "<thinking><tool_call>{}</tool_call></thinking>".format(call),
                }
            }
        ]
    }


class ValidateTest(unittest.TestCase):
    def test_validates_known_name_and_arguments(self):
        result = validate_envelope(envelope({"city": "Tokyo"}), TOOLS)
        self.assertTrue(result.structurally_valid)
        self.assertEqual(result.name_known, "yes")
        self.assertEqual(result.schema_valid, "yes")
        self.assertEqual(result.errors, [])

    def test_malformed_schema_is_unknown(self):
        cases = [
            {"function": {"name": "get_weather", "parameters": []}},
            {"function": {"name": "get_weather", "parameters": {"properties": []}}},
            {"function": {"name": "get_weather", "parameters": {"required": "city"}}},
        ]
        for tool in cases:
            result = validate_envelope(envelope({"city": "Tokyo"}), [tool])
            self.assertTrue(result.structurally_valid)
            self.assertEqual(result.schema_valid, "unknown")
            self.assertTrue(result.errors)

    def test_malformed_schema_fuzz_never_throws_or_claims_validity(self):
        malformed = [None, [], "object", 1, True, {"properties": []}, {"required": "city"}]
        for index in range(400):
            parameters = malformed[(index * 1103515245 + 12345) % len(malformed)]
            result = validate_envelope(
                envelope({"city": "Tokyo" if index % 2 == 0 else index, "nested": {"index": index}}),
                [{"function": {"name": "get_weather", "parameters": parameters}}],
            )
            self.assertNotEqual(result.schema_valid, "yes")

    def test_strict_schema_blocks_entire_parallel_recovery(self):
        calls = "<tool_call>{}</tool_call><tool_call>{}</tool_call>".format(
            json.dumps({"name": "get_weather", "arguments": {"city": "Tokyo"}}),
            json.dumps({"name": "get_weather", "arguments": {"city": 3}}),
        )
        result = check_and_rescue(
            {"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [], "reasoning": "<thinking>{}</thinking>".format(calls)}}]},
            tool_schemas=TOOLS,
            strict_schema=True,
        )
        self.assertTrue(result.detected)
        self.assertEqual(len(result.tool_calls), 2)
        self.assertFalse(result.recovered)

    def test_invalid_name_and_schema_penalties_are_multiplicative(self):
        result = check_and_rescue(
            response({"city": 42, "extra": True}),
            engine_hint="vllm",
            engine_version="0.19.0",
            tool_schemas=[{"function": {"name": "other", "parameters": {"type": "object"}}}],
        )
        self.assertIsNotNone(result.validation)
        self.assertEqual(result.validation.name_known, "no")
        self.assertEqual(result.confidence, 0.48)
        self.assertTrue(result.recovered)

    def test_strict_schema_blocks_invalid_arguments(self):
        result = check_and_rescue(response({"units": "kelvin"}), tool_schemas=TOOLS, strict_schema=True)
        self.assertTrue(result.detected)
        self.assertIsNotNone(result.validation)
        self.assertEqual(result.validation.schema_valid, "no")
        self.assertFalse(result.recovered)
        self.assertIsNone(result.recovered_response)

    def test_min_confidence_blocks_recovery(self):
        result = check_and_rescue(response({"city": "Tokyo"}), min_confidence=0.6)
        self.assertIsNotNone(result.validation)
        self.assertTrue(result.validation.structurally_valid)
        self.assertFalse(result.recovered)


if __name__ == "__main__":
    unittest.main()
