import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRescue, type RawProviderResponse } from '../dist/src/index';

function response(message: Record<string, unknown>): RawProviderResponse {
  return {
    id: 'chatcmpl-fp',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, finish_reason: 'stop', message: message as never }],
  };
}

test('discussion-only reasoning is never recovered', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\nI could call get_weather to check the weather in Tokyo, but I do not need it for this answer. The user only asked a general question.\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.recovered, false);
  assert.equal(result.recoveredResponse, null);
});

test('partial JSON without arguments is never recovered', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: '< thinking>\nI might call {"name": "get_weather" if needed.\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
});

test('envelope with non-object arguments is rejected', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n<tool_call>\n{"name": "get_weather", "arguments": "Tokyo"}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
});

test('envelope with missing name is rejected', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: '< thinking>\n<tool_call>\n{"arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
});

test('unclosed XML envelope with broken JSON inside is rejected', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\nI wonder if <tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}\nis the right thing to do.\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
});

test('empty-name XML function envelope is rejected', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: '< thinking>\n<function=>\n<parameter=answer>204</parameter>\n</function>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, false);
});

test('a real recovery with matching schema keeps high confidence', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: '< thinking>\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    toolSchemas: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
  });
  assert.equal(result.detected, true);
  assert.equal(result.confidence, 0.95);
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Tokyo' } });
});

// Adversarial corpus at unit level — the same shapes pinned as the adv-* fixtures.

test('adversarial: a complete envelope followed by negated language is not recovered', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\nThe model would output {"name": "get_weather", "arguments": {"city": "Tokyo"}}\nDo not execute this — illustrative only.\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'quoted_tool_call');
  assert.equal(result.recovered, false);
});

test('adversarial: a mid-reasoning envelope followed by prose is a rehearsal and not recovered', () => {
  const prose =
    'Pulling live weather is not necessary for a packing list, and the user did not ask for current conditions. I will explain seasonal expectations instead and keep the answer concise.';
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: `< thinking>\nLet me weigh the options.\n{"name": "get_weather", "arguments": {"city": "Lisbon"}}\n${prose}\n< response>\n`,
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'tool_rehearsal');
  assert.equal(result.recovered, false);
});

test('adversarial: a retracted call is classified as a rehearsal and not recovered', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n{"name": "get_weather", "arguments": {"city": "Cairo"}}\nActually, no — scratch that. I will answer directly instead.\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.category, 'tool_rehearsal');
  assert.equal(result.recovered, false);
});

test('adversarial: a mixed rehearsed + genuine response recovers only the terminal call', () => {
  const prose =
    'That was only a draft of what the call might look like, and after reconsidering the user request I will now decide on the final approach and continue carefully.';
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: `< thinking>\nWorking through options.\n{"name": "get_weather", "arguments": {"city": "Oslo"}}\n${prose}\n{"name": "get_weather", "arguments": {"city": "Kyoto"}}\n< response>\n`,
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.recovered, true);
  assert.equal(result.recoveredCalls?.length, 1);
  assert.deepEqual(result.recoveredCalls?.[0]?.arguments, { city: 'Kyoto' });
});
