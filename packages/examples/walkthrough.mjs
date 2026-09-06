/**
 * Runnable walkthrough (TypeScript): a vLLM 0.19-style OpenAI-compatible
 * endpoint swallows a tool call into the reasoning channel. We show the
 * broken client outcome, then heal the same response with checkAndRescue
 * and finish the turn — the exact shape a production agent would hit.
 *
 * Run: npm run walkthrough --workspace examples   (from the repo root)
 * Exits 0 only if every "broken → recovered" assertion holds.
 */
import { checkAndRescue } from 'unswallow';

/** The raw response vLLM 0.19 returned: finish_reason stop, tool_calls []. */
const BROKEN = {
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

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

console.log('unswallow walkthrough (TypeScript)\n');

// 1. The broken path: the client sees a well-formed "no tool call" response.
console.log('Step 1 — the swallow arrives as a normal-looking response');
check('message content is empty', BROKEN.choices[0].message.content === '');
check(
  'tool_calls is an empty array',
  Array.isArray(BROKEN.choices[0].message.tool_calls) && BROKEN.choices[0].message.tool_calls.length === 0
);
check('finish_reason is stop', BROKEN.choices[0].finish_reason === 'stop');
check(
  'an agent loop would stop here — the tool call is trapped in reasoning',
  /<tool_call>/.test(BROKEN.choices[0].message.reasoning ?? '')
);

// 2. checkAndRescue detects it and returns a healed deep copy.
console.log('\nStep 2 — checkAndRescue detects and recovers');
const result = checkAndRescue(BROKEN, {
  engineHint: 'vllm',
  engineVersion: '0.19.0',
  toolSchemas: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ],
});
check('detected is true', result.detected === true);
check('pattern is A (trapped inside reasoning)', result.pattern === 'A');
check('recovered is true', result.recovered === true);
check('confidence is the matrix tier (0.95)', result.confidence === 0.95);
check('matrix row matched', result.matrixMatch?.engine === 'vllm' && result.matrixMatch?.behavior === 'swallow');
check('original response is untouched (deep copy)', BROKEN.choices[0].message.tool_calls.length === 0);
check('tool_calls was rebuilt on the copy', result.recoveredResponse?.choices[0].message.tool_calls?.length === 1);
check(
  'recovered call name',
  result.recoveredResponse?.choices[0].message.tool_calls?.[0]?.function?.name === 'get_weather'
);
check(
  'recovered call arguments',
  result.recoveredResponse?.choices[0].message.tool_calls?.[0]?.function?.arguments === '{"city":"Tokyo"}'
);
check('finish_reason upgraded to tool_calls', result.recoveredResponse?.choices[0].finish_reason === 'tool_calls');

// 3. The healthy path: already-parsed tool_calls pass through untouched.
console.log('\nStep 3 — healthy responses pass through untouched');
const healthy = {
  ...BROKEN,
  id: 'chatcmpl-healthy',
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
};
const healthyResult = checkAndRescue(healthy, { engineHint: 'vllm', engineVersion: '0.24.0' });
check('not detected', healthyResult.detected === false);
check('no recovery performed', healthyResult.recoveredResponse === null);

// 4. The false-positive guard: discussion is never recovered.
console.log('\nStep 4 — a model discussing a tool call is never recovered');
const discussion = checkAndRescue(
  {
    ...BROKEN,
    id: 'chatcmpl-discussion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'I could call get_weather for Tokyo, but I do not need it.',
          tool_calls: [],
        },
      },
    ],
  },
  { engineHint: 'vllm', engineVersion: '0.19.0' }
);
check('not detected', discussion.detected === false);
check('nothing recovered', discussion.recovered === false && discussion.recoveredResponse === null);

console.log(failures === 0 ? '\nAll walkthrough assertions passed.' : `\n${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
