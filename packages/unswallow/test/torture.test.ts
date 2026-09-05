import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRescue, type RawProviderResponse } from '../dist/src/index';

function response(message: Record<string, unknown>, finishReason = 'stop'): RawProviderResponse {
  return {
    id: 'chatcmpl-torture',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, finish_reason: finishReason, message: message as never }],
  };
}

const ENVELOPE = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>';

test('swallowed tool call is recovered when arguments contain unicode content', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "東京都", "note": "日本語のテスト — emoji 🎌 and 中文"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.recovered, true);
  assert.deepEqual(result.toolCall, {
    name: 'get_weather',
    arguments: { city: '東京都', note: '日本語のテスト — emoji 🎌 and 中文' },
  });
  const parsed = JSON.parse(result.recoveredResponse!.choices[0].message.tool_calls![0].function.arguments);
  assert.equal(parsed.city, '東京都');
  assert.equal(parsed.note, '日本語のテスト — emoji 🎌 and 中文');
});

test('escaped quotes and backslashes inside arguments survive recovery byte-identically', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n<tool_call>\n{"name": "submit", "arguments": {"text": "he said \\"hi\\"", "path": "C:\\\\tmp\\\\file.txt"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.deepEqual(result.toolCall, {
    name: 'submit',
    arguments: { text: 'he said "hi"', path: 'C:\\tmp\\file.txt' },
  });
});

test('braces inside JSON string values do not confuse the balanced-JSON scanner', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n<tool_call>\n{"name": "submit", "arguments": {"code": "if (x) { return {ok: 1}; }", "msg": "close } brace"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.recovered, true);
  assert.equal(result.toolCall!.arguments.code, 'if (x) { return {ok: 1}; }');
  assert.equal(result.toolCall!.arguments.msg, 'close } brace');
});

test('deeply nested JSON arguments are recovered intact', () => {
  const nested = { name: 'dispatch', arguments: { task: { steps: [{ type: 'a', cfg: { x: [1, 2, { y: 'z' }] } }] } } };
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: `< thinking>\n<tool_call>\n${JSON.stringify(nested)}\n</tool_call>\n< response>\n`,
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.deepEqual(result.toolCall, nested);
});

test('empty string fields are treated as absent, never recovered', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: '',
    reasoning_content: '',
    thinking: '',
    thought: '',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
  assert.equal(result.confidence, 0);
});

test('null content and null reasoning fields are handled without error', () => {
  const r = response({
    role: 'assistant',
    content: null,
    reasoning: null,
    reasoning_content: null,
    thinking: null,
    thought: null,
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
  assert.equal(result.confidence, 0);
});

test('null tool_calls is not mistaken for an empty array', () => {
  const r = response({
    role: 'assistant',
    content: `I checked the weather. ${ENVELOPE} is what I would use.`,
    tool_calls: null as never,
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'B');
});

test('tool_calls as a non-array truthy value does not crash', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: `< thinking>\n${ENVELOPE}\n< response>\n`,
    tool_calls: 'not-an-array' as never,
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
});

test('missing message content key does not crash', () => {
  const r = response({
    role: 'assistant',
    reasoning: `< thinking>\n${ENVELOPE}\n< response>\n`,
    tool_calls: [],
  } as Record<string, unknown>);
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
});

test('unexpected provider fields alongside a swallow do not interfere', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: `< thinking>\n${ENVELOPE}\n< response>\n`,
    tool_calls: [],
    logprobs: { content: [{ token: 'x', logprob: -0.3 }] },
    annotation: null,
    extras: { meta: [1, 2, 3] },
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.recoveredResponse!.choices[0].message.extras!.meta[2], 3);
});

test('additionalFields named like reasoning channels are scanned', () => {
  const r = response({
    role: 'assistant',
    content: '',
    thought_of: 'hmm',
    tool_calls: [],
  });
  const result = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    additionalFields: ['thought_of'],
  });
  assert.equal(result.detected, false);
  const r2 = response({
    role: 'assistant',
    content: '',
    thought_of: `< thinking>\n${ENVELOPE}\n< response>\n`,
    tool_calls: [],
  });
  const result2 = checkAndRescue(r2, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    additionalFields: ['thought_of'],
  });
  assert.equal(result2.detected, true);
  assert.equal(result2.pattern, 'A');
  assert.equal(result2.source, 'thought_of');
});

test('reasoning that merely contains JSON-like fragments is never recovered', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\nThe JSON schema was {"type": "object", "properties": {"city": {"type": "string"}}}. I will not call anything.\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
});

test('reasoning describing a truncated candidate call is never recovered', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\nTo call a tool I would emit {"name": "get_weather", "arguments": {"city": "Oslo" but this answer needs no tool — the object above is only an example.\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
});

test('arguments containing a JSON string with braces/escapes survive (argumentsFromString path)', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n<tool_call>\n{"name": "submit", "arguments": "{\\"code\\": \\"if (x) { return; }\\", \\"msg\\": \\"hi\\\\nbye\\"}"}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.recovered, true);
  assert.ok(result.warnings.some((w) => w.includes('JSON string and were parsed')));
  assert.deepEqual(result.toolCall, { name: 'submit', arguments: { code: 'if (x) { return; }', msg: 'hi\nbye' } });
});

test('long reasoning output containing a swallow is still recovered', () => {
  const chunk = 'The weather discussion continues with relevant analysis and numerical estimates for the forecast. ';
  let reasoning = '< thinking>\n';
  for (let i = 0; i < 300; i++) {
    reasoning += chunk + i + '\n';
  }
  reasoning += `${ENVELOPE}\n`;
  for (let i = 0; i < 300; i++) {
    reasoning += chunk + i + '\n';
  }
  reasoning += '< response>\n';
  const r = response({ role: 'assistant', content: '', reasoning, tool_calls: [] });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.recovered, true);
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Tokyo' } });
});

test('multiple reasoning/tool-call boundaries in one response recover each envelope', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\nFirst plan.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Oslo"}}\n</tool_call>\n< response>\nI will do that.\n< thinking>\nWait, also check Berlin.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Berlin"}}\n</tool_call>\n< response>\nDone.\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.deepEqual(
    result.toolCalls!.map((t) => t.arguments.city),
    ['Oslo', 'Berlin']
  );
});

test('content split across tool calls with interleaved reasoning recovers content envelope', () => {
  const r = response({
    role: 'assistant',
    content:
      'Here you go.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Rome"}}\n</tool_call>\nThen I will summarize the result for you below.\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'B');
  assert.equal(result.recovered, true);
  assert.equal(result.toolCall!.arguments.city, 'Rome');
});
