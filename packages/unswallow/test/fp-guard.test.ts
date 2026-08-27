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
