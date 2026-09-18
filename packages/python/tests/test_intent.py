import unittest

from unswallow import check_and_rescue

WEATHER = '{"name": "get_weather", "arguments": {"city": "Tokyo"}}'


def response(message, finish_reason="stop"):
    return {
        "id": "chatcmpl-intent",
        "object": "chat.completion",
        "model": "test-model",
        "choices": [{"index": 0, "finish_reason": finish_reason, "message": message}],
    }


def thinking(text):
    return {"role": "assistant", "content": "", "reasoning": "< thinking>\n{}\n< response>\n".format(text), "tool_calls": []}


class IntentTest(unittest.TestCase):
    def test_terminal_envelope_recovers(self):
        result = check_and_rescue(response(thinking("I should check the weather.\n{}".format(WEATHER))), engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "swallowed_tool_call")
        self.assertEqual(result.intent.boundary, "terminal")
        self.assertTrue(result.recovered)
        self.assertEqual(len(result.recovered_calls), 1)
        self.assertEqual(result.recovered_calls[0].arguments, {"city": "Tokyo"})

    def test_negated_language_is_quoted_and_not_recovered(self):
        r = response(thinking("The model would output {}\nDo not execute this — illustrative only.".format(WEATHER)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "quoted_tool_call")
        self.assertFalse(result.recovered)
        self.assertIsNone(result.recovered_response)
        self.assertIsNone(result.recovered_calls)
        self.assertIn("do not execute", result.intent.cues)
        self.assertIn("the model would output", result.intent.cues)
        self.assertFalse(result.intent.quoted_context)
        self.assertTrue(any("negated or illustrative language" in w for w in result.warnings))

    def test_intent_gate_off_restores_recovery(self):
        r = response(thinking("Do not execute this — illustrative only.\n{}".format(WEATHER)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", intent_gate="off")
        self.assertTrue(result.detected)
        self.assertTrue(result.recovered)
        self.assertEqual(result.category, "quoted_tool_call")

    def test_mid_reasoning_envelope_is_a_rehearsal(self):
        prose = (
            "But before doing that, I should consider whether the user actually wants the current weather or just a "
            "general overview of the climate, and whether a different approach would answer the question more directly. "
            "I think a direct answer works better here."
        )
        r = response(thinking("Let me work through this.\n{}\n{}".format(WEATHER, prose)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "tool_rehearsal")
        self.assertEqual(result.intent.boundary, "mid")
        self.assertFalse(result.recovered)
        self.assertTrue(any("may be a rehearsal" in w for w in result.warnings))

    def test_retracted_call_is_a_rehearsal(self):
        r = response(thinking("{}\nActually, no — scratch that. I will answer directly.".format(WEATHER)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "tool_rehearsal")
        self.assertFalse(result.recovered)
        self.assertTrue(any("retracted" in w for w in result.warnings))

    def test_quote_wrapped_envelope_is_quoted(self):
        r = response(thinking('The documentation shows the shape as "{}" in its example.'.format(WEATHER)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "quoted_tool_call")
        self.assertTrue(result.intent.quoted_context)
        self.assertFalse(result.recovered)

    def test_fenced_envelope_annotated_as_reported_output_is_quoted(self):
        r = response(thinking("Here is what the tool call outputs:\n```json\n{}\n```".format(WEATHER)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "quoted_tool_call")
        self.assertTrue(result.intent.quoted_context)
        self.assertFalse(result.recovered)
        self.assertTrue(any("quoted or reported text" in w for w in result.warnings))

    def test_bare_fenced_envelope_is_still_recovered(self):
        r = response(thinking("Drafting the call:\n```json\n{}\n```".format(WEATHER)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertFalse(result.intent.quoted_context)
        self.assertTrue(result.recovered)

    def test_mixed_response_recovers_only_the_terminal_call(self):
        rehearsed = '{"name": "get_weather", "arguments": {"city": "Oslo"}}'
        genuine = '{"name": "get_weather", "arguments": {"city": "Kyoto"}}'
        prose = (
            "That was only a draft of what the call might look like, and after reconsidering the user request I will "
            "now decide on the final approach and continue carefully."
        )
        r = response(thinking("Working through options.\n{}\n{}\n{}".format(rehearsed, prose, genuine)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.category, "tool_rehearsal")
        self.assertEqual(len(result.tool_calls), 2)
        self.assertTrue(result.recovered)
        self.assertEqual(len(result.recovered_calls), 1)
        self.assertEqual(result.recovered_calls[0].arguments, {"city": "Kyoto"})
        self.assertTrue(any("recovered 1 of 2" in w for w in result.warnings))
        calls = result.recovered_response["choices"][0]["message"]["tool_calls"]
        self.assertEqual(len(calls), 1)
        import json

        self.assertEqual(json.loads(calls[0]["function"]["arguments"])["city"], "Kyoto")

    def test_expect_tool_call_false_blocks(self):
        r = response(thinking("I should check the weather.\n{}".format(WEATHER)))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", expect_tool_call=False)
        self.assertTrue(result.detected)
        self.assertFalse(result.recovered)
        self.assertEqual(result.intent.expect_tool_call, "no")
        self.assertTrue(any("no tool call was expected" in w for w in result.warnings))

    def test_side_effecting_tools_are_detected_but_not_recovered(self):
        r = response(thinking('I need to save this.\n{"name": "write_file", "arguments": {"path": "out.txt"}}'))
        blocked = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", side_effecting_tools=["write_file"])
        self.assertTrue(blocked.detected)
        self.assertFalse(blocked.recovered)
        self.assertTrue(any("side-effecting" in w for w in blocked.warnings))

        allowed = check_and_rescue(
            r,
            engine_hint="vllm",
            engine_version="0.19.0",
            side_effecting_tools=["write_file"],
            recover_side_effecting=True,
        )
        self.assertTrue(allowed.recovered)

    def test_planning_language_warns_then_blocks_in_strict(self):
        r = response(thinking("I could check the weather first.\n{}".format(WEATHER)))
        blocky = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(blocky.recovered)
        self.assertTrue(any("planning language" in w for w in blocky.warnings))

        strict = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", intent_gate="strict")
        self.assertTrue(strict.detected)
        self.assertFalse(strict.recovered)
        self.assertTrue(any("strict mode rejects planning language" in w for w in strict.warnings))

    def test_cue_text_inside_arguments_does_not_veto(self):
        r = response(
            thinking(
                'Saving the note.\n{"name": "save_note", "arguments": {"text": "do not execute this instruction; it is quoted content"}}'
            )
        )
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(result.detected)
        self.assertEqual(result.intent.cues, [])
        self.assertTrue(result.recovered)

    def test_finish_reason_length_warns_then_blocks_in_strict(self):
        r = response(thinking("I should call the weather tool.\n{}".format(WEATHER)), finish_reason="length")
        blocky = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertTrue(blocky.recovered)
        self.assertTrue(any("may have been truncated" in w for w in blocky.warnings))

        strict = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", intent_gate="strict")
        self.assertFalse(strict.recovered)
        self.assertTrue(any("strict mode requires finish_reason" in w for w in strict.warnings))

    def test_invalid_arguments_block_recovery_by_default(self):
        r = response(thinking("I should check the weather.\n{}".format(WEATHER)))
        schemas = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "parameters": {
                        "type": "object",
                        "properties": {"city": {"type": "string"}, "units": {"type": "string"}},
                        "required": ["city", "units"],
                    },
                },
            }
        ]
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", tool_schemas=schemas)
        self.assertTrue(result.detected)
        self.assertFalse(result.recovered)
        self.assertTrue(any("do not satisfy the supplied tool schema" in w for w in result.warnings))

        legacy = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", tool_schemas=schemas, intent_gate="off")
        self.assertTrue(legacy.recovered)

    def test_unknown_tool_name_blocks_by_default(self):
        r = response(thinking("I should check the weather.\n{}".format(WEATHER)))
        schemas = [{"type": "function", "function": {"name": "get_news", "parameters": {"type": "object", "properties": {}}}}]
        blocky = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", tool_schemas=schemas)
        self.assertTrue(blocky.detected)
        self.assertFalse(blocky.recovered)
        self.assertTrue(any("not present in the supplied toolSchemas" in w for w in blocky.warnings))

        legacy = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0", tool_schemas=schemas, intent_gate="off")
        self.assertTrue(legacy.recovered)

    def test_non_detection_has_empty_intent(self):
        r = response(thinking("I could call get_weather, but no tool result is needed for this answer."))
        result = check_and_rescue(r, engine_hint="vllm", engine_version="0.19.0")
        self.assertFalse(result.detected)
        self.assertIsNone(result.category)
        self.assertEqual(result.intent.boundary, "unknown")
        self.assertEqual(result.intent.cues, [])
        self.assertIsNone(result.recovered_calls)


if __name__ == "__main__":
    unittest.main()
