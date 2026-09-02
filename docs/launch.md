# Launch runbook (maintainer-only)

Everything needed to publish and launch unswallow. Repo state is launch-ready:
CI green (node 20/22 + python 3.9/3.11/3.13 + parity), demo GIF rendered, badges live.

## 1. Publish (requires your credentials — ~5 minutes)

```bash
# --- npm (run from this repo root) ---
npm adduser                      # interactive; you may need an OTP
cd packages/unswallow && npm publish
cd ../matrix && npm publish      # unswallow-matrix, own release cycle
cd ../..

# --- PyPI ---
python -m pip install build twine
python -m build --sdist --wheel --outdir dist packages/python
python -m twine upload dist/*    # username: __token__, password: your PyPI API token
```

Verify both registries:

```bash
mkdir /tmp/verify-npm && cd /tmp/verify-npm && npm init -y && npm i unswallow && npx unswallow check
python -m venv /tmp/verify-pip && /tmp/verify-pip/bin/pip install unswallow && unswallow check
```

Bump versions for any later release:
`packages/unswallow/package.json`, `packages/matrix/package.json`,
`packages/python/pyproject.toml`, `packages/python/unswallow/__init__.py`
(and `unswallow`'s dependency range on `unswallow-matrix` if the matrix releases first).

## 2. Repo settings (GitHub web UI, ~1 minute)

Settings → General → Description:
`Detect and recover tool calls trapped inside a model's reasoning channel (vLLM, SGLang, llama.cpp).`
Topics: `llm`, `agents`, `tool-calls`, `function-calling`, `reasoning`, `vllm`, `sglang`, `llama.cpp`, `qwen3`, `deepseek`
Enable Discussions (useful for "my server swallowed a call" threads).

## 3. Issue-thread comments (paste when ready)

### vLLM #39056 — https://github.com/vllm-project/vllm/issues/39056

> Built a small tool for exactly this failure mode, in case it helps others in this thread:
> `npx unswallow check` runs a self-test against a bundled copy of your reproduction,
> `--endpoint` probes a live server, and `--fixture` works on captured raw responses.
> It detects the swallow (patterns A/B/C), recovers the tool call in place, and ships a
> sourced engine/version matrix — including the note that the `qwen3_coder → qwen3_xml`
> workaround is a no-op on current versions, and Bug 2 from this thread
> (`tool_choice: "required"`, PR #35936) as a pinned fixture. The matrix's fixHint matches
> the direction of PR #35687.
>
> Zero runtime dependencies; `pip install unswallow` mirror with exact cross-language
> parity; 15/15 pinned benchmark fixtures; the matrix is refreshed weekly from the tracked
> upstream threads. If you hit this in production, your raw response becomes a pinned
> fixture with attribution: https://github.com/0DukePan/unswallow

### llama.cpp #20837 — https://github.com/ggml-org/llama.cpp/issues/20837

> Same failure mode here (tool calls in XML inside the thinking block). I built a small
> tool that detects and recovers this class of swallow on llama.cpp, vLLM, and SGLang:
> `npx unswallow check` runs a bundled reproduction, `--endpoint` probes a live server.
> Your thinking-block-in-content shape is a pinned fixture. Zero dependencies, Python
> mirror included: https://github.com/0DukePan/unswallow

### SGLang #30744 — https://github.com/sgl-project/sglang/issues/30744

> Built a tool for this class of bug (tool calls swallowed into `reasoning_content`):
> `npx unswallow check` self-tests a bundled reproduction, `--endpoint` probes a live
> server. Your exact `reasoning_content` shape is a pinned fixture. Zero dependencies,
> Python mirror included: https://github.com/0DukePan/unswallow

### Optional follow-ups

- pi #952 (closed): brief thanks — "our Pattern B fixture is built from your
  extractFirstJsonObject case."
- open-webui #23339: "for the history side of this, unswallow ships `sanitizeHistory`
  / `stripReasoningTags` — a hygiene pass that strips leaked reasoning artifacts before
  re-sending."

## 4. Show HN

Title:
`Show HN: I built a tool that finds tool calls your LLM server silently swallows`

First comment (the substance — post it yourself immediately):

```
Your agent's model decided to call a tool. The server returned HTTP 200, finish_reason: stop,
tool_calls: []. Your agent loop read "no tool call" and silently stopped mid-task. No crash,
no error, no log line.

The tool call is sitting, fully formed, inside the reasoning / reasoning_content / thinking
field — emitted before the model closed its think block, routed into reasoning by the
server-side parser, never seen by the tool parser. Confirmed on vLLM (#39056), SGLang
(#30744), llama.cpp (#20837).

What I built: a library + CLI + proxy that detects and recovers this bug class.
  - `npx unswallow check` — self-test demo, or `--endpoint` against your live server
  - recovery is structural, never keyword-based: a model merely *discussing* a tool call
    is never "recovered" (pinned adversarial fixtures enforce this)
  - engine/version behavior matrix, every row sourced, refreshed weekly
  - `pip install unswallow` — 1:1 Python mirror, 15/15 fixtures with exact cross-language
    parity; zero dependencies in both

Numbers from the committed benchmark suite (run on your own hardware: npm run bench:perf):
  - ~0.05–0.13 ms per check on realistic payloads (~8k–21k ops/s)
  - 1 MB reasoning block: ~1.7 ms, linear
  - proxy adds ~1 ms per request (it's a second HTTP hop, not the detection)
  - healthy responses return before any scanning

Demo: https://github.com/0DukePan/unswallow (GIF at the top of the README)

Honest caveats: the scope is deliberately narrow — this is the reasoning-channel swallow
bug class, not a general tool-call repair proxy. And vLLM's own fix may eventually resolve
the worst cases server-side; the tool still matters for hosted APIs (OpenRouter, Together,
Moonshot) where you can't set serving flags.
```

## 5. X thread (3 posts, ~1 hour after Show HN)

1. "Your LLM agent just silently stopped mid-task. The tool call WAS generated — your
   server just buried it in the reasoning field and returned `tool_calls: []`. No error.
   No crash. This is the reasoning-channel swallow, confirmed on vLLM, SGLang, llama.cpp."
2. "I built a zero-dep tool that finds and recovers it: `npx unswallow check` against your
   live endpoint. One command. Before/after: [demo.gif]."
3. "15/15 pinned benchmark fixtures, exact TS↔Python parity, and a weekly-refreshed
   engine matrix where every row is sourced. If your server swallows a call, your raw
   response becomes a fixture. https://github.com/0DukePan/unswallow"

## 6. Post-launch loop (weeks 1–4)

- Reply to every swallow report on the issue threads; ask for raw responses.
- Convert responses into fixtures (issue template exists) → corpus grows → README table.
- The weekly Matrix Watch workflow (cron) updates upstream status; review the PR it opens.
- If a vLLM/SGLang maintainer replies or adopts: quote-post on X, update README.
- Watch for a compounding event; amplify it when it happens.