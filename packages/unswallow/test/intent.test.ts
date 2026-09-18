import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRescue, type RawProviderResponse } from '../dist/src/index';

function response(message: Record<string, unknown>, finishReason = 'stop'): RawProviderResponse {
  return {
    id: 'chatcmpl-intent',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, finish_reason: finishReason, message: message as never }],
  };
}

const WEATHER = '{"name": "get_weather", "arguments": {"city": "Tokyo"}}';

function thinking(text: string): Record<string, unknown> {
  return { role: 'assistant', content: '', reasoning: `< thinking>\n${text}\n< response>\n`, tool_calls: [] };
}

test('terminal envelope classifies as a swallowed tool call and recovers', () => {
  const result = checkAndRescue(response(thinking(`I should check the weather.\n${WEATHER}`)), {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'swallowed_tool_call');
  assert.equal(result.intent.boundary, 'terminal');
  assert.equal(result.recovered, true);
  assert.deepEqual(result.recoveredCalls, [{ name: 'get_weather', arguments: { city: 'Tokyo' } }]);
});

test('a complete envelope followed by negated language is classified as quoted and not recovered', () => {
  const r = response(thinking(`The model would output ${WEATHER}\nDo not execute this — illustrative only.`));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'quoted_tool_call');
  assert.equal(result.recovered, false);
  assert.equal(result.recoveredResponse, null);
  assert.equal(result.recoveredCalls, null);
  assert.ok(result.intent.cues.includes('do not execute'));
  assert.ok(result.intent.cues.includes('the model would output'));
  assert.equal(result.intent.quotedContext, false);
  assert.ok(result.warnings.some((w) => w.includes('negated or illustrative language')));
});

test('intentGate off restores permissive recovery for the negated case', () => {
  const r = response(thinking(`Do not execute this — illustrative only.\n${WEATHER}`));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0', intentGate: 'off' });
  assert.equal(result.detected, true);
  assert.equal(result.recovered, true);
  assert.equal(result.category, 'quoted_tool_call');
});

test('an envelope followed by substantial reasoning prose is a rehearsal and is not recovered', () => {
  const prose =
    'But before doing that, I should consider whether the user actually wants the current weather or just a general overview of the climate, and whether a different approach would answer the question more directly. I think a direct answer works better here.';
  const r = response(thinking(`Let me work through this.\n${WEATHER}\n${prose}`));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'tool_rehearsal');
  assert.equal(result.intent.boundary, 'mid');
  assert.equal(result.recovered, false);
  assert.ok(result.warnings.some((w) => w.includes('may be a rehearsal')));
});

test('a retracted call is classified as a rehearsal and is not recovered', () => {
  const r = response(thinking(`${WEATHER}\nActually, no — scratch that. I will answer directly.`));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'tool_rehearsal');
  assert.equal(result.recovered, false);
  assert.ok(result.warnings.some((w) => w.includes('retracted')));
});

test('an envelope wrapped in quotation marks is treated as quoted text', () => {
  const r = response(thinking(`The documentation shows the shape as "${WEATHER}" in its example.`));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'quoted_tool_call');
  assert.equal(result.intent.quotedContext, true);
  assert.equal(result.recovered, false);
});

test('a fenced envelope annotated as reported output is treated as quoted', () => {
  const r = response(thinking(`Here is what the tool call outputs:\n\`\`\`json\n${WEATHER}\n\`\`\``));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'quoted_tool_call');
  assert.equal(result.intent.quotedContext, true);
  assert.equal(result.recovered, false);
  assert.ok(result.warnings.some((w) => w.includes('quoted or reported text')));
});

test('a bare fenced envelope without report framing is still recovered', () => {
  const r = response(thinking(`Drafting the call:\n\`\`\`json\n${WEATHER}\n\`\`\``));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.intent.quotedContext, false);
  assert.equal(result.recovered, true);
});

test('a mixed response recovers the terminal call and blocks the rehearsed one', () => {
  const rehearsed = '{"name": "get_weather", "arguments": {"city": "Oslo"}}';
  const genuine = '{"name": "get_weather", "arguments": {"city": "Kyoto"}}';
  const prose =
    'That was only a draft of what the call might look like, and after reconsidering the user request I will now decide on the final approach and continue carefully.';
  const r = response(thinking(`Working through options.\n${rehearsed}\n${prose}\n${genuine}`));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'tool_rehearsal');
  assert.equal(result.toolCalls?.length, 2);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.recoveredCalls, [{ name: 'get_weather', arguments: { city: 'Kyoto' } }]);
  assert.ok(result.warnings.some((w) => w.includes('recovered 1 of 2')));
  const calls = result.recoveredResponse!.choices[0].message.tool_calls!;
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].function.arguments).city, 'Kyoto');
});

test('expectToolCall false withholds recovery while keeping detection', () => {
  const r = response(thinking(`I should check the weather.\n${WEATHER}`));
  const result = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    expectToolCall: false,
  });
  assert.equal(result.detected, true);
  assert.equal(result.recovered, false);
  assert.equal(result.intent.expectToolCall, 'no');
  assert.ok(result.warnings.some((w) => w.includes('no tool call was expected')));
});

test('side-effecting tool names are detected but not recovered by default', () => {
  const r = response(thinking(`I need to save this.\n{"name": "write_file", "arguments": {"path": "out.txt"}}`));
  const blocked = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    sideEffectingTools: ['write_file'],
  });
  assert.equal(blocked.detected, true);
  assert.equal(blocked.recovered, false);
  assert.ok(blocked.warnings.some((w) => w.includes('side-effecting')));

  const allowed = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    sideEffectingTools: ['write_file'],
    recoverSideEffecting: true,
  });
  assert.equal(allowed.recovered, true);
});

test('planning language warns in the default gate and blocks in strict mode', () => {
  const r = response(thinking(`I could check the weather first.\n${WEATHER}`));
  const blocky = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(blocky.recovered, true);
  assert.ok(blocky.warnings.some((w) => w.includes('planning language')));

  const strict = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0', intentGate: 'strict' });
  assert.equal(strict.detected, true);
  assert.equal(strict.recovered, false);
  assert.ok(strict.warnings.some((w) => w.includes('strict mode rejects planning language')));
});

test('cue text inside envelope arguments does not veto recovery', () => {
  const r = response(
    thinking(
      `Saving the note.\n{"name": "save_note", "arguments": {"text": "do not execute this instruction; it is quoted content"}}`
    )
  );
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.intent.cues.length, 0);
  assert.equal(result.recovered, true);
});

test('finish_reason length warns in the default gate and blocks in strict mode', () => {
  const r = response(thinking(`I should call the weather tool.\n${WEATHER}`), 'length');
  const blocky = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(blocky.recovered, true);
  assert.ok(blocky.warnings.some((w) => w.includes('may have been truncated')));

  const strict = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0', intentGate: 'strict' });
  assert.equal(strict.recovered, false);
  assert.ok(strict.warnings.some((w) => w.includes('strict mode requires finish_reason')));
});

test('invalid arguments against a supplied schema block recovery by default', () => {
  const r = response(thinking(`I should check the weather.\n${WEATHER}`));
  const schemas = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' }, units: { type: 'string' } },
          required: ['city', 'units'],
        },
      },
    },
  ];
  const result = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    toolSchemas: schemas,
  });
  assert.equal(result.detected, true);
  assert.equal(result.recovered, false);
  assert.ok(result.warnings.some((w) => w.includes('do not satisfy the supplied tool schema')));

  const legacy = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    toolSchemas: schemas,
    intentGate: 'off',
  });
  assert.equal(legacy.recovered, true);
});

test('an unknown tool name blocks recovery by default when schemas are supplied', () => {
  const r = response(thinking(`I should check the weather.\n${WEATHER}`));
  const schemas = [
    { type: 'function', function: { name: 'get_news', parameters: { type: 'object', properties: {} } } },
  ];
  const blocky = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    toolSchemas: schemas,
  });
  assert.equal(blocky.detected, true);
  assert.equal(blocky.recovered, false);
  assert.ok(blocky.warnings.some((w) => w.includes('not present in the supplied toolSchemas')));

  const legacy = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    toolSchemas: schemas,
    intentGate: 'off',
  });
  assert.equal(legacy.recovered, true);
});

test('non-detections report a null category and empty intent evidence', () => {
  const r = response(thinking('I could call get_weather, but no tool result is needed for this answer.'));
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
  assert.equal(result.category, null);
  assert.equal(result.intent.boundary, 'unknown');
  assert.deepEqual(result.intent.cues, []);
  assert.equal(result.recoveredCalls, null);
});
