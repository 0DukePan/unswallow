# Framework integrations

unswallow ships two first-class adapters — a **LiteLLM callback** (Python)
and an **OpenTelemetry adapter** (TS + Python) — plus copy-paste patterns for
the SDKs most people actually talk to these engines with. Every integration
imports its framework lazily: installing `unswallow` never drags in litellm,
an OTel SDK, or an AI SDK.

The detection core is identical everywhere; only the seam differs.

## LiteLLM (Python)

LiteLLM sits in front of vLLM/SGLang for a large share of self-hosted
deployments, which makes it the exact surface where swallows happen. Attach
the callback once at startup:

```python
import litellm
from unswallow.integrations.litellm import make_swallow_logger

def on_detect(message, calls):
    print(f"swallowed tool call(s) recovered: {[c['name'] for c in calls]}")

logger = make_swallow_logger(on_detect=on_detect)  # None if litellm isn't installed
if logger is not None:
    litellm.callbacks.append(logger)
```

The callback fires for every completion and streaming response that carried a
swallowed, recoverable tool call. It detects and reports; it does not rewrite
the pydantic response in place — for in-place recovery use the proxy mode
(`npx unswallow proxy --upstream <url>`).

## OpenTelemetry (TS + Python)

Spans + a detection counter, wired into the tracer/meter you already have:

```ts
import { trace, metrics } from '@opentelemetry/api';
import { checkAndRescue, observeCheckResult } from 'unswallow';

const result = checkAndRescue(response);
observeCheckResult(result, {
  tracer: trace.getTracer('app'),
  meter: metrics.getMeter('app'),
});
```

```python
from opentelemetry import trace, metrics
from unswallow import check_and_rescue, observe_check_result

result = check_and_rescue(response)
observe_check_result(result, tracer=trace.get_tracer("app"), meter=metrics.get_meter("app"))
```

Emits a `unswallow.check` span (attributes: `detected`, `pattern`,
`recovered`, `confidence`, `engine`) and a `unswallow.detections` counter.
That turns the library from "a debugging tool you run once" into something
that stays in the request path as your swallow-rate monitor.

## OpenAI SDK (Python + Node)

A response interceptor — detect and log after every completion; recover in
place only where you control the message shape:

```python
from openai import OpenAI
from unswallow import check_and_rescue, apply_recovery_to_response

client = OpenAI()

def guarded_create(*args, **kwargs):
    response = client.chat.completions.create(*args, **kwargs)
    for choice in response.choices:
        message = choice.message
        result = check_and_rescue(
            {"choices": [{"index": 0, "finish_reason": choice.finish_reason, "message": message.model_dump()}]}
        )
        if result.recovered:
            print(f"recovered swallowed call: {result.tool_calls[0].name}")
    return response
```

```js
import OpenAI from 'openai';
import { checkAndRescue } from 'unswallow';

const client = new OpenAI();
const create = client.chat.completions.create.bind(client.chat.completions);

client.chat.completions.create = async (...args) => {
  const response = await create(...args);
  for (const choice of response.choices ?? []) {
    const result = checkAndRescue({ choices: [{ index: 0, finish_reason: choice.finish_reason, message: choice.message }] });
    if (result.recovered) console.log(`recovered swallowed call: ${result.toolCalls?.[0]?.name}`);
  }
  return response;
};
```

## Vercel AI SDK (Node/TS)

Sketch for `wrapLanguageModel` (v5; `experimental_wrapLanguageModel` in v4).
The middleware re-checks the assembled generation result — adapt the field
access to your SDK version, since `reasoning` handling changed across v4/v5:

```ts
import { wrapLanguageModel } from 'ai';
import { checkAndRescue } from 'unswallow';

const guarded = wrapLanguageModel({
  model,
  middleware: {
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      const message = {
        content: result.text ?? '',
        reasoning: result.reasoning ?? '',
        tool_calls: (result.toolCalls ?? []).map((c) => ({
          id: c.toolCallId, type: 'function',
          function: { name: c.toolName, arguments: JSON.stringify(c.args) },
        })),
      };
      const check = checkAndRescue({
        choices: [{ index: 0, finish_reason: 'stop', message }],
      });
      if (check.recovered) {
        // Merge the recovered calls back into result.toolCalls.
        console.warn(`swallow recovered: ${check.toolCalls?.map((c) => c.name)}`);
      }
      return result;
    },
  },
});
```

## LangChain / LlamaIndex

No formal plugin API is needed for a pure post-processing step: wrap the
model's `.invoke()` / `acall()` output and run the same
`checkAndRescue`-on-message pattern as the OpenAI SDK snippet above. If you
maintain a wrapper you'd like canonicalized here, a PR is welcome.