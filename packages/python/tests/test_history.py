import unittest

from unswallow import sanitize_history, strip_reasoning_tags


class HistoryTest(unittest.TestCase):
    def test_strip_complete_think_blocks(self):
        text = "< thinking>\nI should get the weather for Tokyo.\n< response>\nThe weather in Tokyo is 24C."
        self.assertEqual(strip_reasoning_tags(text), "The weather in Tokyo is 24C.")

    def test_strip_xml_thinking_blocks(self):
        text = "<thinking>\nplanning\n</thinking>\nFinal answer here."
        self.assertEqual(strip_reasoning_tags(text), "Final answer here.")

    def test_leak_keeps_text_drops_tag(self):
        text = "Here is the summary. <mm:think>I should verify the weather data first"
        self.assertEqual(strip_reasoning_tags(text), "Here is the summary. I should verify the weather data first")

    def test_plain_text_untouched(self):
        text = "The user asked about the weather and I answered directly."
        self.assertEqual(strip_reasoning_tags(text), text)

    def test_word_think_not_eaten(self):
        text = "I think this is a great question."
        self.assertEqual(strip_reasoning_tags(text), text)

    def test_sanitize_history(self):
        history = [
            {"role": "user", "content": "What is the weather?"},
            {
                "role": "assistant",
                "content": "< thinking>\nI need a tool.\n< response>\nLet me call the tool.",
                "reasoning": "< thinking>\nI need a tool.\n< response>\n",
                "reasoning_content": "< thinking>\nI need a tool.\n< response>\n",
            },
            {"role": "tool", "content": "24C"},
        ]
        frozen = json_repr(history)
        clean = sanitize_history(history)
        self.assertEqual(json_repr(history), frozen)
        self.assertEqual(len(clean), 3)
        self.assertEqual(clean[0]["content"], "What is the weather?")
        self.assertEqual(clean[1]["content"], "Let me call the tool.")
        self.assertNotIn("reasoning", clean[1])
        self.assertNotIn("reasoning_content", clean[1])
        self.assertEqual(clean[2]["content"], "24C")

    def test_options(self):
        history = [{"role": "assistant", "content": "answer", "thinking": "< thinking>\nplan\n< response>\n"}]
        clean = sanitize_history(history, strip_reasoning_fields=False)
        self.assertEqual(clean[0]["thinking"], "< thinking>\nplan\n< response>\n")
        clean2 = sanitize_history(history, strip_reasoning_tags_opt=False)
        self.assertEqual(clean2[0]["content"], "answer")
        clean3 = sanitize_history(history, strip_reasoning_fields=False, strip_reasoning_tags_opt=False)
        self.assertEqual(clean3, history)


def json_repr(obj):
    import json

    return json.dumps(obj, sort_keys=True)


if __name__ == "__main__":
    unittest.main()
