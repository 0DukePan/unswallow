import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAndRescueStream,
  createStreamAccumulator,
  type StreamChunk,
} from '../dist/src/index';

function chunk(delta: Record<string, unknown>, finishReason?: string | null): StreamChunk {
  return {
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        finish_reason: finishReason ?? null,
        delta: delta as never,
      },
    ],
  };
}

async function* iter(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c;
}

test('streaming: envelope split across many deltas mid-tag and mid-JSON-string', async () => {
  const chunks = [
    chunk({ reasoning: '  thi' }),
    chunk({ reasoning: 'nk\nI need the weather for ' }),
    chunk({ reasoning: 'Tokyo.\n<tool_ca' }),
    chunk({ reasoning: 'll>\n{"name": "get_w' }),
    chunk({ reasoning: 'eather", "arguments": {"ci' }),
    chunk({ reasoning: 'ty": "Tokyo"}}\n</tool_' }),
    chunk({ reasoning: 'call>\n  respo' }),
    chunk({ reasoning: 'nse\n' }),
    chunk({ content: '' }, 'stop'),
  ];
  const result = await checkAndRescueStream(iter(chunks), {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.recovered, true);
  assert.equal(result.confidence, 0.95);
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Tokyo' } });
  assert.ok(result.recoveredResponse);
  assert.equal(result.recoveredResponse!.choices[0].finish_reason, 'tool_calls');
  const calls = result.recoveredResponse!.choices[0].message.tool_calls!;
  assert.equal(calls[0].function.name, 'get_weather');
  assert.equal(calls[0].function.arguments, JSON.stringify({ city: 'Tokyo' }));
});

test('streaming: whole envelope arriving in a single multi-token delta', async () => {
  const chunks = [
    chunk({
      reasoning:
        '< thinking>\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Oslo"}}\n</tool_call>\n< response>\n',
    }),
    chunk({}, 'stop'),
  ];
  const result = await checkAndRescueStream(iter(chunks), {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  assert.equal(result.detected, true);
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Oslo' } });
});

test('streaming: tag-like text inside a JSON string is not counted as a tag (string-literal-aware)', async () => {
  const chunks = [
    chunk({ reasoning: '< thinking>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n< response>\n' }),
    chunk({}, 'stop'),
  ];
  const acc = createStreamAccumulator();
  for (const c of chunks) acc.push(c);
  const response = acc.end();
  assert.equal(response.choices[0].message.reasoning, '< thinking>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n< response>\n');
});

test('streaming: pattern B with trailing reasoning text after JSON in content deltas', async () => {
  const chunks = [
    chunk({ content: '{"name": "get_weather", "arguments": {"city": "Bei' }),
    chunk({ content: 'jing"}}' }),
    chunk({ content: '\n\nLet me also check whether anything else is relevant to report.' }),
    chunk({}, 'stop'),
  ];
  const result = await checkAndRescueStream(iter(chunks));
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'B');
  assert.equal(result.recovered, true);
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Beijing' } });
});

test('streaming: pattern C leak surfaces via onLeak and end classification', async () => {
  const leaks: string[] = [];
  const chunks = [
    chunk({ content: 'Here is the summary. <mm:thi' }),
    chunk({ content: 'nk>I should verify the weather data first' }),
    chunk({}, 'stop'),
  ];
  const result = await checkAndRescueStream(iter(chunks), { onLeak: (n) => leaks.push(n) });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'C');
  assert.equal(result.recovered, false);
  assert.ok(result.confidence <= 0.5);
  assert.ok(leaks.length >= 1);
});

test('streaming: healthy streamed tool call is left untouched', async () => {
  const chunks = [
    chunk({ reasoning: '< thinking>\nI will call get_weather.\n< response>\n' }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":' },
        },
      ],
    }),
    chunk({
      tool_calls: [{ index: 0, function: { arguments: ' "Rome"}' } }] as never,
    }),
    chunk({}, 'tool_calls'),
  ];
  const result = await checkAndRescueStream(iter(chunks), {
    engineHint: 'vllm',
    engineVersion: '0.24.0',
  });
  assert.equal(result.detected, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.recoveredResponse, null);
});

test('streaming: buffer guard throws on runaway streams', async () => {
  const acc = createStreamAccumulator({ maxBufferBytes: 64 });
  assert.throws(() => acc.push(chunk({ content: 'x'.repeat(100) })), RangeError);
});

test('streaming: finish_reason stop is upgraded to tool_calls on recovery', async () => {
  const chunks = [
    chunk({
      reasoning: '< thinking>\n<tool_call>{"name": "get_weather", "arguments": {"city": "Kyoto"}}</tool_call>\n< response>\n',
    }),
    chunk({}, 'stop'),
  ];
  const result = await checkAndRescueStream(iter(chunks), {
    engineHint: 'llama.cpp',
    engineVersion: 'b8461',
  });
  assert.equal(result.recovered, true);
  assert.equal(result.recoveredResponse!.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.confidence, 0.95);
});

test('streaming: accumulated response preserves id/model and assembled channels', () => {
  const acc = createStreamAccumulator();
  acc.push({ id: 'chatcmpl-42', model: 'Qwen3.5-35B-A3B-FP8', choices: [{ delta: { reasoning: '< thinking>\n' } }] as never });
  acc.push({ id: 'chatcmpl-42', model: 'Qwen3.5-35B-A3B-FP8', choices: [{ delta: { reasoning: 'hello' } }] as never });
  acc.push({ choices: [{ delta: { content: 'answer' } }] as never });
  const response = acc.end();
  assert.equal(response.id, 'chatcmpl-42');
  assert.equal(response.model, 'Qwen3.5-35B-A3B-FP8');
  assert.equal(response.choices[0].message.reasoning, '< thinking>\nhello');
  assert.equal(response.choices[0].message.content, 'answer');
  assert.equal(response.choices[0].finish_reason, 'stop');
});

test('streaming: parallel tool calls split across deltas are all recovered', async () => {
  const chunks = [
    chunk({ reasoning: '< thinking>\nTwo parallel searches.\n<tool_call>{"name": "se' }),
    chunk({ reasoning: 'arch", "arguments": {"query": "one"}}</tool_call>\n<tool_ca' }),
    chunk({ reasoning: 'll>{"name": "search", "arguments": {"query": "two"}}</tool_call>\n< res' }),
    chunk({ reasoning: 'ponse>\n' }),
    chunk({}, 'stop'),
  ];
  const result = await checkAndRescueStream(iter(chunks), {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.equal(result.recovered, true);
  assert.deepEqual(
    result.toolCalls,
    [
      { name: 'search', arguments: { query: 'one' } },
      { name: 'search', arguments: { query: 'two' } },
    ]
  );
  const calls = result.recoveredResponse!.choices[0].message.tool_calls!;
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].function.arguments).query, 'one');
  assert.equal(JSON.parse(calls[1].function.arguments).query, 'two');
});