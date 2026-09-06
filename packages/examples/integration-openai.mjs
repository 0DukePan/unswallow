/**
 * Runnable integration example — OpenAI-compatible client.
 *
 * Simulates the OpenAI SDK response shape an agent library receives when a
 * vLLM 0.19-style server swallows a tool call into the reasoning channel,
 * then shows the two ways a real agent stack integrates unswallow:
 *
 *   1. wire-level: heal the response BEFORE the SDK parses it (proxy mode);
 *   2. application-level: heal the SDK's parsed response object and hand the
 *      recovered tool_calls to the agent loop (checkAndRescue).
 *
 * Run: npm run walkthrough --workspace=@unswallow/examples  (this file)
 *      npm run integration --workspace=@unswallow/examples
 * Exits 0 only if every assertion holds.
 */
import { checkAndRescue } from 'unswallow';

/** What vLLM 0.19 returned for a tool-requiring request. */
const SWALLOWED_RESPONSE = {
  id: 'chatcmpl-vllm-0.19-swallowed',
  object: 'chat.completion',
  model: 'Qwen/Qwen3-30B-A3B',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        reasoning:
          '<thinking>\nThe user wants the weather in Tokyo. I should use the get_weather tool.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n</thinking>\n',
        tool_calls: [],
      },
    },
  ],
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Current weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

// --- the agent's tool executor ---------------------------------------------

const executed = [];
function executeTool(name, args) {
  // A real agent would call the registered function here.
  executed.push({ name, args });
  if (name === 'get_weather') return { temperature: 24, condition: 'sunny', city: args.city };
  throw new Error(`unknown tool ${name}`);
}

console.log('unswallow × OpenAI-compatible client\n');

// Step 1 — the SDK's parsed response looks like a deliberate non-action.
console.log('Step 1 — the client receives a well-formed "no tool call" response');
const sdkResponse = JSON.parse(JSON.stringify(SWALLOWED_RESPONSE));
const message = sdkResponse.choices[0].message;
check('tool_calls is empty', Array.isArray(message.tool_calls) && message.tool_calls.length === 0);
check('finish_reason is stop', sdkResponse.choices[0].finish_reason === 'stop');
check('the agent loop would stop here (tool call trapped in reasoning)', /<tool_call>/.test(message.reasoning));

// Step 2 — application-level: run the response through unswallow.
console.log('\nStep 2 — heal the response with checkAndRescue');
const result = checkAndRescue(sdkResponse, {
  engineHint: 'vllm',
  engineVersion: '0.19.0',
  toolSchemas: TOOLS,
});
check('detected (pattern A)', result.detected === true && result.pattern === 'A');
check('recovered with matrix-tier confidence', result.recovered === true && result.confidence === 0.95);
check('original response untouched', message.tool_calls.length === 0);

// Step 3 — feed the recovered tool_calls to the agent loop.
console.log('\nStep 3 — the agent executes the recovered tool call');
const recovered = result.recoveredResponse;
const calls = recovered.choices[0].message.tool_calls;
check('tool_calls rebuilt with the call', calls.length === 1 && calls[0].function.name === 'get_weather');
check('finish_reason upgraded', recovered.choices[0].finish_reason === 'tool_calls');

for (const call of calls) {
  const output = executeTool(call.function.name, JSON.parse(call.function.arguments));
  check(`executed ${call.function.name}(${call.function.arguments})`, output.city === 'Tokyo' && output.temperature === 24);
}

// Step 4 — healthy responses (already parsed) pass through untouched.
console.log('\nStep 4 — healthy responses never trigger recovery');
const healthy = JSON.parse(
  JSON.stringify({
    ...SWALLOWED_RESPONSE,
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Osaka"}' } }],
        },
      },
    ],
  })
);
const healthyResult = checkAndRescue(healthy, { engineHint: 'vllm', engineVersion: '0.24.0' });
check('not detected, nothing recovered', healthyResult.detected === false && healthyResult.recoveredResponse === null);

console.log('\nExecuted tools:', JSON.stringify(executed));
console.log(failures === 0 ? '\nAll integration assertions passed.' : `\n${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
