"""Runner for the real-framework integrations (LangChain + LlamaIndex).

Starts the mock swallowing upstream and the unswallow proxy, runs both
framework integrations against the proxy, then tears everything down.

Requires: langchain-openai, llama-index, openai (pip install in a venv),
and a built TS core (npm run build).

Run from the repo root:
    python packages/examples/run_framework_integrations.py
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NODE = "node"
PYTHON = sys.executable
MOCK_PORT = 18080
PROXY_PORT = 18787
MOCK_URL = "http://127.0.0.1:{}".format(MOCK_PORT)
PROXY_URL = "http://127.0.0.1:{}".format(PROXY_PORT)

procs = []


def wait_port(port, timeout=30):
    import socket

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def main():
    mock = subprocess.Popen(
        [NODE, str(ROOT / "packages" / "examples" / "_mock_upstream.mjs"), str(MOCK_PORT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    procs.append(mock)
    if not wait_port(MOCK_PORT, timeout=10):
        print("mock upstream did not start")
        return 1

    proxy = subprocess.Popen(
        [
            NODE,
            str(ROOT / "packages" / "unswallow" / "dist" / "cli" / "index.js"),
            "proxy",
            "--upstream",
            MOCK_URL,
            "--port",
            str(PROXY_PORT),
            "--engine",
            "llama.cpp",
            "--version",
            "b8461",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    procs.append(proxy)
    time.sleep(1.5)

    results = []
    for script in ("integration_langchain.py", "integration_llama_index.py"):
        p = Path(__file__).resolve().parent / script
        print("=" * 20, script, "=" * 20, flush=True)
        rc = subprocess.call([PYTHON, str(p)])
        results.append((script, rc))
        print("", flush=True)

    for script, rc in results:
        print("{}: {}".format(script, "OK" if rc == 0 else "FAIL rc={}".format(rc)))
    return 0 if all(rc == 0 for _, rc in results) else 1


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        for p in procs:
            try:
                p.terminate()
            except Exception:  # noqa: BLE001
                pass
            try:
                p.wait(timeout=5)
            except Exception:  # noqa: BLE001
                p.kill()
    sys.exit(rc)
