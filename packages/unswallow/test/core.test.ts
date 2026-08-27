import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRescue, normalizeEngine, type RawProviderResponse } from '../dist/src/index';

function response(message: Record<string, unknown>, finishReason = 'stop'): RawProviderResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, finish_reason: finishReason, message: message as never }],
  };
}

test('Pattern A: function-xml envelope trapped in reasoning (vLLM #39056 shape)', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\nI need to answer the user\u2019s question. The answer is 204.\n<tool_call>\n<function=Finish>\n<parameter=answer>\n204\n</parameter>\n</function>\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.source, 'reasoning');
  assert.equal(result.recovered, true);
  assert.equal(result.confidence, 0.95);
  assert.deepEqual(result.toolCall, { name: 'Finish', arguments: { answer: 204 } });
  assert.ok(result.recoveredResponse);
  const calls = result.recoveredResponse!.choices[0].message.tool_calls!;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'Finish');
  assert.equal(calls[0].function.arguments, JSON.stringify({ answer: 204 }));
  assert.equal(result.recoveredResponse!.choices[0].finish_reason, 'tool_calls');
});

test('Pattern A: JSON envelope in reasoning_content (SGLang #30744 shape)', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning_content:
      '< thinking>\nI should get the weather for Tokyo.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'sglang', engineVersion: '0.4.6' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.source, 'reasoning_content');
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Tokyo' } });
  assert.equal(result.confidence, 0.95);
});

test('Pattern A: envelope inside a think block in content (llama.cpp #20837 shape)', () => {
  const r = response({
    role: 'assistant',
    content:
      '<thinking>\nThe user wants the weather in Berlin.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Berlin"}}\n</tool_call>\n</thinking>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'llama.cpp', engineVersion: '8461' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.source, 'thinking');
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Berlin' } });
});

test('Pattern A: DeepSeek separator envelope in reasoning_content', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning_content:
      '< thinking>\nI need to call a tool.\n<｜tool▁calls▁begin｜><｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_call<｜tool▁sep｜>\n{"name": "get_weather", "arguments": {"city": "Shanghai"}}\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'sglang', engineVersion: '0.4.6' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Shanghai' } });
});

test('Pattern B: envelope in content with trailing reasoning text (pi #952 shape)', () => {
  const r = response({
    role: 'assistant',
    content:
      '{"name": "get_weather", "arguments": {"city": "Beijing"}}\n\nLet me also check whether there is any other useful information to report.\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'llama.cpp', engineVersion: '8461' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'B');
  assert.equal(result.source, 'content');
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Beijing' } });
  assert.equal(result.recovered, true);
  assert.equal(result.confidence, 0.55);
  assert.ok(result.warnings.some((w) => w.startsWith('trailing text')));
});

test('Pattern B: complete JSON envelope in content never parsed into tool_calls', () => {
  const r = response({
    role: 'assistant',
    content: '{"name": "get_weather", "arguments": {"city": "Paris"}}',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.26.0' });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'B');
  assert.equal(result.recovered, true);
});

test('Pattern C: unclosed reasoning tag leak in content is detection-only', () => {
  const r = response({
    role: 'assistant',
    content: 'Here is the answer. <mm:think>I should verify the weather data first',
    tool_calls: [],
  });
  const result = checkAndRescue(r);
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'C');
  assert.equal(result.recovered, false);
  assert.ok(result.confidence <= 0.5);
});

test('healthy response with parsed tool_calls is left untouched', () => {
  const r = response(
    {
      role: 'assistant',
      content: '',
      reasoning: '< thinking>\nI will call get_weather.\n< response>\n',
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city": "Tokyo"}' },
        },
      ],
    },
    'tool_calls'
  );
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.24.0' });
  assert.equal(result.detected, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.recoveredResponse, null);
});

test('matrix "resolved" range detection warns about wrong version reporting', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning:
      '< thinking>\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.25.0' });
  assert.equal(result.detected, true);
  assert.equal(result.confidence, 0.6);
  assert.ok(result.matrixMatch);
  assert.equal(result.matrixMatch!.behavior, 'resolved');
  assert.ok(result.warnings.some((w) => w.includes('resolved')));
});

test('unknown engine/version falls back to heuristic confidence with warnings', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: '< thinking>\n{"name": "get_weather", "arguments": {"city": "Rome"}}\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r);
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.confidence, 0.55);
  assert.equal(result.engineHint, 'unknown');
  assert.equal(result.matrixMatch, null);
  assert.ok(result.warnings.some((w) => w.includes('engineHint')));
});

test('toolSchemas mismatch lowers confidence and warns', () => {
  const r = response({
    role: 'assistant',
    content: '',
    reasoning: '< thinking>\n{"name": "get_weather", "arguments": {"city": "Oslo"}}\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
    toolSchemas: [
      {
        type: 'function',
        function: { name: 'get_news', parameters: { type: 'object', properties: {} } },
      },
    ],
  });
  assert.equal(result.confidence, 0.85);
  assert.ok(result.warnings.some((w) => w.includes('not found in provided toolSchemas')));
});

test('missing choices yields a non-detection with a warning', () => {
  const result = checkAndRescue({ choices: [] } as RawProviderResponse);
  assert.equal(result.detected, false);
  assert.equal(result.confidence, 0);
  assert.ok(result.warnings.length > 0);
});

test('normalizeEngine accepts the canonical engine spellings', () => {
  assert.equal(normalizeEngine('vllm'), 'vllm');
  assert.equal(normalizeEngine('sglang'), 'sglang');
  assert.equal(normalizeEngine('llama.cpp'), 'llama.cpp');
  assert.equal(normalizeEngine('llama-cpp'), 'llama.cpp');
  assert.equal(normalizeEngine('llamacpp'), 'llama.cpp');
  assert.equal(normalizeEngine('LLAMA.CPP'), 'llama.cpp');
  assert.equal(normalizeEngine('anything-else'), 'unknown');
  assert.equal(normalizeEngine(), 'unknown');
});

test('multiple envelopes in different reasoning regions warn', () => {
  const r = response({
    role: 'assistant',
    content:
      '{"name": "get_news", "arguments": {"topic": "ai"}}\n',
    reasoning:
      '< thinking>\n{"name": "get_weather", "arguments": {"city": "Kyoto"}}\n< response>\n',
    tool_calls: [],
  });
  const result = checkAndRescue(r, { engineHint: 'vllm', engineVersion: '0.19.0' });
  assert.equal(result.pattern, 'A');
  assert.equal(result.toolCall!.name, 'get_weather');
  assert.ok(result.warnings.some((w) => w.includes('additional envelope')));
});
