# Opt-in real-engine reproduction

This Docker Compose configuration is for manual or scheduled runs on a
self-hosted NVIDIA GPU runner. It is deliberately excluded from normal CI:
model downloads are large, engine behavior is version-sensitive, and GPU
availability should not block contributor pull requests.

## Start SGLang

```bash
MODEL_ID=<exact-model-revision> \
SGLANG_IMAGE=lmsysorg/sglang@sha256:<verified-image-digest> \
docker compose -f packages/bench/real-engines/compose.yaml --profile sglang up
npm run live-probe -- --case packages/bench/live-probe/cases/live-sglang-qwen3.6-pattern-a.json \
  --endpoint http://localhost:30000/v1 --model <exact-model-revision> \
  --engine sglang --version <exact-engine-version> \
  --out packages/bench/live-probe/results-sglang-qwen3.6.json
```

`SGLANG_IMAGE` and `VLLM_IMAGE` are required and must use immutable image
digests (for example, `registry/image@sha256:...`); mutable tags such as
`latest` are intentionally rejected. Record the image digest, server version,
model revision, launch flags, and raw pre-recovery response before creating a
pinned fixture. See `docs/reproduction.md` for the evidence checklist.
