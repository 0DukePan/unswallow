# SGLang real captures

`qwen3.6-pattern-a.json` is intentionally absent until a real SGLang +
Qwen3.6 probe produces the sourced Pattern A failure. Do not add a synthetic
stand-in here or mark the matrix row verified.

Use `packages/bench/live-probe/cases/live-sglang-qwen3.6-pattern-a.json` and
follow `docs/reproduction.md`. A reviewed capture must include the raw
pre-recovery response and metadata for the engine version/commit, model
revision, launch flags, prompt, tool schema, and timestamp. Then add the
fixture to the hash manifest using `npm run pin`.
