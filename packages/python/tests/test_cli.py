import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from unswallow.cli import main


def response(message):
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "model": "test-model",
        "choices": [{"index": 0, "finish_reason": "stop", "message": message}],
    }


def swallowed_response():
    return response(
        {
            "role": "assistant",
            "content": "",
            "reasoning": (
                "<thinking>Need weather.</thinking>"
                '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>'
            ),
            "tool_calls": [],
        }
    )


class CliTest(unittest.TestCase):
    def run_cli(self, argv):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_inspect_reports_validation_in_json_and_human_output(self):
        schema = [
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
        ]
        with tempfile.TemporaryDirectory() as directory:
            fixture_path = Path(directory) / "response.json"
            schema_path = Path(directory) / "tools.json"
            fixture_path.write_text(json.dumps(swallowed_response()), encoding="utf-8")
            schema_path.write_text(json.dumps({"tools": schema}), encoding="utf-8")

            code, output, errors = self.run_cli(["inspect", str(fixture_path), "--schema", str(schema_path), "--json"])
            self.assertEqual(code, 1)
            self.assertEqual(errors, "")
            report = json.loads(output)
            self.assertEqual(report["validation"], {
                "structurallyValid": True,
                "nameKnown": "yes",
                "schemaValid": "yes",
                "errors": [],
            })

            code, output, errors = self.run_cli(["inspect", str(fixture_path), "--schema", str(schema_path)])
            self.assertEqual(code, 1)
            self.assertEqual(errors, "")
            self.assertIn("validation    : name=yes, schema=yes, structural=True", output)

    def test_doctor_reports_healthy_affected_and_recovery_supported(self):
        cases = [
            (
                response({"role": "assistant", "content": "No tool needed.", "tool_calls": []}),
                "healthy",
                0,
            ),
            (
                response({"role": "assistant", "content": "Answer. <mm:think>Need a tool", "tool_calls": []}),
                "affected",
                1,
            ),
            (swallowed_response(), "recovery-supported", 1),
        ]
        for probe_response, expected_status, expected_code in cases:
            with self.subTest(status=expected_status), patch(
                "unswallow.cli._probe", return_value=(200, probe_response)
            ):
                code, output, errors = self.run_cli(
                    ["doctor", "--endpoint", "http://example.test/v1", "--model", "test", "--json"]
                )
            self.assertEqual(code, expected_code)
            self.assertEqual(errors, "")
            self.assertEqual(json.loads(output)["status"], expected_status)

    def test_doctor_prints_matrix_fix_hint(self):
        with patch("unswallow.cli._probe", return_value=(200, swallowed_response())):
            code, output, errors = self.run_cli(
                [
                    "doctor",
                    "--endpoint",
                    "http://example.test/v1",
                    "--model",
                    "test",
                    "--engine",
                    "vllm",
                    "--version",
                    "0.19.0",
                ]
            )
        self.assertEqual(code, 1)
        self.assertEqual(errors, "")
        self.assertIn("unswallow doctor: recovery-supported", output)
        self.assertIn("recommendation :", output)


if __name__ == "__main__":
    unittest.main()
