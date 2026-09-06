import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRescue, sanitizeHistory, stripReasoningTags } from '../dist/src/index';
import type { RawProviderResponse } from '../dist/src/index';

function response(message: Record<string, unknown>, finishReason = 'stop'): RawProviderResponse {
  return {
    id: 'chatcmpl-edges',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, finish_reason: finishReason, message: message as never }],
  };
}

const VLLM = { engineHint: 'vllm', engineVersion: '0.19.0' };

// ---- Parsing edges --------------------------------------------------------

test('arguments containing a literal newline sequence survive as JSON, not as line breaks', () => {
  // Inside a JSON string, \\n is an escape — recovery must keep it escaped in
  // the rebuilt arguments string so a later JSON.parse yields the newline.
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n<tool_call>\n{"name": "log_note", "arguments": {"note": "line1\\nline2"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, VLLM);
  assert.equal(result.detected, true);
  assert.deepEqual(result.toolCall, { name: 'log_note', arguments: { note: 'line1\nline2' } });
  const args = result.recoveredResponse!.choices[0].message.tool_calls![0].function.arguments;
  const parsed = JSON.parse(args);
  assert.equal(parsed.note, 'line1\nline2');
});

test('non-ASCII whitespace inside JSON is preserved', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n<tool_call>\n{"name": "edit", "arguments": {"text": "a\u00a0b\u2003c"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, VLLM);
  assert.equal(result.detected, true);
  assert.deepEqual(result.toolCall, { name: 'edit', arguments: { text: 'a\u00a0b\u2003c' } });
});

test('JSON envelope padded with surrounding whitespace in the reasoning channel is recovered', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n  \n\t<tool_call>\n   \n{"name": "get_weather", "arguments": {"city": "Osaka"}}\n   \n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, VLLM);
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
});

test('content string that is only whitespace is treated as absent content', () => {
  const r = response({
    role: 'assistant',
    content: '   \n\t ',
    reasoning: '< thinking>\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, VLLM);
  assert.equal(result.detected, true);
  assert.equal(result.recovered, true);
});

test('missing content key does not throw and reasoning-envelope recovery still works', () => {
  const msg = {
    role: 'assistant',
    reasoning: '<thinking>\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Kyoto"}}\n</tool_call>\n</thinking>\n',
    tool_calls: [],
  };
  const r = response(msg);
  const result = checkAndRescue(r, VLLM);
  assert.equal(result.detected, true);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.toolCall!.arguments, { city: 'Kyoto' });
});

test('multiple envelopes across mixed channels recover every unique call', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '<thinking>\n<tool_call>\n{"name": "search", "arguments": {"q": "alpha"}}\n</tool_call>\n<tool_call>\n{"name": "search", "arguments": {"q": "beta"}}\n</tool_call>\n</thinking>\n',
    reasoning_content:
      '<thinking>\n<function=get_weather>\n<parameter=city>Nara</parameter>\n</function>\n</thinking>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, VLLM);
  assert.equal(result.detected, true);
  assert.equal(result.toolCalls!.length, 3);
  const names = result.toolCalls!.map((c) => c.name);
  assert.deepEqual(names, ['search', 'search', 'get_weather']);
});

// ---- Streaming edges ------------------------------------------------------

test('streaming: reasoning channel arrives interleaved with empty deltas and non-string fields', async () => {
  const chunks = [
    { id: 'chatcmpl-e', model: 'm', choices: [{ index: 0, finish_reason: null, delta: { reasoning: '< think' } }] },
    { choices: [{ index: 0, finish_reason: null, delta: {} }] },
    { choices: [{ index: 0, finish_reason: null, delta: { reasoning: 'ing>\n' } }] },
    { choices: [{ index: 0, finish_reason: null, delta: { reasoning: null } }] },
    { choices: [{ index: 0, finish_reason: null, delta: { reasoning: 42 } }] },
    { choices: [{ index: 0, finish_reason: null, delta: { content: '' } }] },
    {
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { reasoning: '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n' },
        },
      ],
    },
    { choices: [{ index: 0, finish_reason: 'stop', delta: {} }] },
  ];
  const { checkAndRescueStream } = await import('../dist/src/index');
  const result = await checkAndRescueStream(chunks as never, VLLM);
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.recovered, true);
  assert.equal(result.toolCall!.name, 'get_weather');
});

test('streaming: tool call that arrives fully in one delta is not double-counted', async () => {
  const chunks = [
    { id: 'chatcmpl-e2', model: 'm', choices: [{ index: 0, finish_reason: null, delta: { content: '' } }] },
    { choices: [{ index: 0, finish_reason: null, delta: { content: '' } }] },
    {
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { reasoning: '<thinking>\nI will search.\n<tool_call>\n{"name": "search", "arguments": {"q": "x"}}\n</tool_call>\n</thinking>\n' },
        },
      ],
    },
    { choices: [{ index: 0, finish_reason: 'stop', delta: {} }] },
  ];
  const { checkAndRescueStream } = await import('../dist/src/index');
  const result = await checkAndRescueStream(chunks as never, VLLM);
  assert.equal(result.recovered, true);
  assert.equal(result.toolCalls!.length, 1);
});

test('streaming: healthy streamed tool_calls finish unchanged (no recovery)', async () => {
  const chunks = [
    { id: 'chatcmpl-e3', model: 'm', choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] },
    { choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Osaka"}' } }] } }] },
    { choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] },
  ];
  const { checkAndRescueStream } = await import('../dist/src/index');
  const result = await checkAndRescueStream(chunks as never, { engineHint: 'vllm', engineVersion: '0.24.0' });
  assert.equal(result.detected, false);
  assert.equal(result.recovered, false);
});

// ---- History / pattern D edges --------------------------------------------

test('sanitizeHistory: assistant tool call with missing tool result is preserved', () => {
  const history = [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: '',
      reasoning: '< thinking>\nplan\n< response>\n',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }],
    },
    // note: the tool result message is missing — the turn is corrupted
  ];
  const clean = sanitizeHistory(history);
  assert.equal(clean.length, 2);
  assert.equal(clean[1].tool_calls?.length, 1);
  assert.equal(clean[1].tool_calls![0].function.name, 'get_weather');
  assert.equal('reasoning' in clean[1], false);
});

test('sanitizeHistory: prior-turn tool calls with broken function entries survive', () => {
  const history = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{bad json' } }] },
    { role: 'tool', content: 'no result' },
    { role: 'user', content: 'again' },
  ];
  const clean = sanitizeHistory(history);
  assert.equal(clean.length, 3);
  assert.deepEqual(clean[0].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{bad json' } }]);
});

test('stripReasoningTags removes a complete block whose answer follows on the same line', () => {
  const text = '<thinking>\nshort plan\n</thinking>The weather is 24C.';
  assert.equal(stripReasoningTags(text), 'The weather is 24C.');
});

test('stripReasoningTags handles unicode reasoning inside a complete block', () => {
  const text = '<thinking>\n日本語で計画する 計画\n</thinking>\n答え：24度';
  assert.equal(stripReasoningTags(text), '答え：24度');
});

test('checkAndRescue: empty-string tool name in a healthy tool_calls array does not crash', () => {
  const r = response(
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_x', type: 'function', function: { name: '', arguments: '{}' } }],
    },
    'tool_calls'
  );
  const result = checkAndRescue(r, VLLM);
  assert.equal(result.detected, false);
  assert.equal(result.recovered, false);
});
