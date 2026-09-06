"""Real LlamaIndex integration through the unswallow proxy.

The upstream mock swallows the tool call; the unswallow proxy heals it;
LlamaIndex's FunctionAgent binds + executes the recovered read_file tool.

Run (from repo root, after starting the mock + proxy):
    python packages/examples/integration_llama_index.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from llama_index.core.agent import FunctionAgent  # noqa: E402
from llama_index.core.tools import FunctionTool  # noqa: E402
from llama_index.llms.openai import OpenAI  # noqa: E402

PROXY_BASE = "http://127.0.0.1:18787/v1"
MODEL = "gpt-4o-mini"  # llama-index validates the name; the mock ignores it


def read_file(path: str) -> str:
    """Read a file (the real tool the recovered call will execute)."""
    if path == "package.json":
        return '{\n  "name": "example-repo",\n  "scripts": {"build": "tsc", "test": "vitest"}\n}'
    return '{"error": "file not found"}'


async def main():
    llm = OpenAI(api_base=PROXY_BASE, api_key="sk-local", model=MODEL, temperature=0)
    tool = FunctionTool.from_defaults(fn=read_file, name="read_file", description="Read a file from the project.")
    agent = FunctionAgent(
        tools=[tool],
        llm=llm,
        system_prompt="You are a coding agent. Use read_file when you need a file's contents.",
        streaming=False,
        verbose=False,
    )
    handler = agent.run("Read package.json and tell me what scripts are defined.")
    response = await handler
    text = str(response)
    print("Agent response:", text[:300])
    if "tsc" in text and "vitest" in text:
        print("LLAMAINDEX INTEGRATION OK: recovered tool executed through the proxy")
        return 0
    print("FAIL: agent did not report the scripts from the recovered tool call")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
