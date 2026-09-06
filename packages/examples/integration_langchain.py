"""Real LangChain integration through the unswallow proxy.

The upstream mock swallows the tool call (XML envelope in
reasoning_content, no tool_calls). The unswallow proxy in front of it
heals the response, and LangChain's ChatOpenAI binds + executes the
recovered read_file tool — proving the full
normal -> swallow -> unswallow -> recovered -> execute chain with a real
framework.

Run (from repo root, after starting the mock + proxy):
    python packages/examples/integration_langchain.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from langchain_openai import ChatOpenAI  # noqa: E402

PROXY_BASE = "http://127.0.0.1:18787/v1"
MODEL = "llamacpp-mock"


def read_file(path: str) -> str:
    """Read a file (the real tool the recovered call will execute)."""
    if path == "package.json":
        return '{\n  "name": "example-repo",\n  "scripts": {"build": "tsc", "test": "vitest"}\n}'
    return '{"error": "file not found"}'


def main():
    llm = ChatOpenAI(base_url=PROXY_BASE, api_key="none", model=MODEL, temperature=0)
    llm_with_tools = llm.bind_tools([read_file])
    resp = llm_with_tools.invoke(
        [
            ("system", "You are a coding agent. Use read_file when you need a file's contents."),
            ("human", "Read package.json and report the scripts."),
        ]
    )
    print("AIMessage content:", repr(resp.content))
    print("AIMessage tool_calls:", resp.tool_calls)
    if not resp.tool_calls:
        print("FAIL: no tool_calls recovered through the proxy")
        return 1
    for tc in resp.tool_calls:
        name = tc["name"]
        args = tc["args"]
        print("executing", name, args)
        out = read_file(args["path"])
        print("tool result:", out.replace("\n", " ")[:120])
    print("LANGCHAIN INTEGRATION OK: recovered tool executed through the proxy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
