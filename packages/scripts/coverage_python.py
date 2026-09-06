"""Python coverage runner for CI/dev — stdlib coverage if importable, else
install coverage into a temp venv (keeps the repo dependency-free).
Runs unittest discovery with coverage over the unswallow package and prints
a summary. Exit code 0 on success (coverage numbers are informational, not a
gate — behavioral coverage matters more than a percentage).
"""

import subprocess
import sys
import tempfile
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYTHON_PKG = ROOT / "packages" / "python"


def has_module(name):
    return subprocess.run(
        [sys.executable, "-c", "import {}".format(name)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def main():
    python = sys.executable
    if not has_module("coverage"):
        print("coverage: not installed — installing into a temporary venv...")
        tmp = tempfile.mkdtemp(prefix="unswallow-cov-")
        venv.create(tmp, with_pip=True)
        python = str(Path(tmp) / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python"))
        subprocess.run([python, "-m", "pip", "install", "--quiet", "coverage"], check=True)

    cmd = [
        python,
        "-m",
        "coverage",
        "run",
        "--source=unswallow",
        "--branch",
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests",
        "-t",
        ".",
    ]
    r = subprocess.run(cmd, cwd=str(PYTHON_PKG))
    if r.returncode != 0:
        return r.returncode
    r2 = subprocess.run([python, "-m", "coverage", "report", "-m"], cwd=str(PYTHON_PKG))
    return r2.returncode


if __name__ == "__main__":
    sys.exit(main())
