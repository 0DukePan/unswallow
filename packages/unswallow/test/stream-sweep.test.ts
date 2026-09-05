import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRescueStream, type StreamChunk } from '../dist/src/index';

function chunk(delta: Record<string, unknown>, finishReason?: string | null): StreamChunk {
  return {
    id: 'chatcmpl-sweep',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, finish_reason: finishReason ?? null, delta: delta as never }],
  };
}

async function* iter(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c;
}

const STREAM_TEXT =
  '< thinking>\nI need the weather for Tokyo.\n<tool_call>\n' +
  '{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n' +
  '</tool_call>\n< response>\n';

const TERMINATOR = chunk({}, 'stop');

function streamSplitAt(offsets: number[]): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  let prev = 0;
  for (const off of [...offsets, STREAM_TEXT.length]) {
    const piece = STREAM_TEXT.slice(prev, off);
    prev = off;
    if (piece.length > 0) chunks.push(chunk({ reasoning: piece }));
  }
  chunks.push(TERMINATOR);
  return chunks;
}

test('chunk sweep: every single-character split yields the same recovery as the whole payload', async () => {
  const reference = await checkAndRescueStream(iter([chunk({ reasoning: STREAM_TEXT }), TERMINATOR]), {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  assert.equal(reference.detected, true);
  assert.equal(reference.pattern, 'A');
  assert.equal(reference.recovered, true);

  for (let i = 1; i < STREAM_TEXT.length; i++) {
    const result = await checkAndRescueStream(iter(streamSplitAt([i])), {
      engineHint: 'vllm',
      engineVersion: '0.19.0',
    });
    assert.equal(result.detected, true, `split at ${i} must detect`);
    assert.equal(result.pattern, 'A', `split at ${i} must classify A`);
    assert.equal(result.recovered, true, `split at ${i} must recover`);
    assert.deepEqual(
      result.toolCall,
      { name: 'get_weather', arguments: { city: 'Tokyo' } },
      `split at ${i} must recover the same call`
    );
    assert.equal(result.recoveredResponse!.choices[0].finish_reason, 'tool_calls', `split at ${i}`);
  }
});

test('chunk sweep: every two-character split yields the same recovery as the whole payload', async () => {
  const reference = await checkAndRescueStream(iter([chunk({ reasoning: STREAM_TEXT }), TERMINATOR]), {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  for (let i = 1; i < STREAM_TEXT.length - 1; i++) {
    const result = await checkAndRescueStream(iter(streamSplitAt([i, i + 2])), {
      engineHint: 'vllm',
      engineVersion: '0.19.0',
    });
    assert.equal(result.detected, true, `split at ${i},${i + 2} must detect`);
    assert.equal(result.pattern, 'A', `split at ${i},${i + 2} must classify A`);
    assert.deepEqual(
      result.toolCall,
      reference.toolCall,
      `split at ${i},${i + 2} must recover the same call`
    );
    assert.equal(result.recoveredResponse!.choices[0].finish_reason, 'tool_calls', `split at ${i},${i + 2}`);
  }
});

test('chunk sweep: splits at every tag boundary inside the envelope reproduce the result', async () => {
  const boundaryOffsets = [0];
  for (let i = 0; i < STREAM_TEXT.length - 1; i++) {
    if (STREAM_TEXT[i] === '<' && /[a-zA-Z]/.test(STREAM_TEXT[i + 1] ?? '')) {
      boundaryOffsets.push(i);
    }
  }
  boundaryOffsets.push(STREAM_TEXT.length);
  const reference = await checkAndRescueStream(iter([chunk({ reasoning: STREAM_TEXT }), TERMINATOR]), {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  for (let i = 1; i < boundaryOffsets.length - 1; i++) {
    const result = await checkAndRescueStream(iter(streamSplitAt([boundaryOffsets[i]])), {
      engineHint: 'vllm',
      engineVersion: '0.19.0',
    });
    assert.equal(result.detected, true, `boundary split at ${boundaryOffsets[i]} must detect`);
    assert.equal(result.recovered, true, `boundary split at ${boundaryOffsets[i]} must recover`);
    assert.deepEqual(result.toolCall, reference.toolCall, `boundary split at ${boundaryOffsets[i]}`);
  }
});

test('chunk sweep: token-scale alternating reasoning/content deltas reconstruct the full message', async () => {
  const reasoningPieces = STREAM_TEXT.match(/.{1,8}/gs)!;
  const chunks = reasoningPieces.map((piece) => chunk({ reasoning: piece }));
  chunks.push(TERMINATOR);
  const result = await checkAndRescueStream(iter(chunks), {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  assert.equal(result.detected, true);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Tokyo' } });
});

test('chunk sweep: empty deltas and content-only bookkeeping deltas interleaved are ignored', async () => {
  const result = await checkAndRescueStream(
    iter([
      chunk({ reasoning: '< thinking>\n<tool_call>\n{"name": "get_' }),
      chunk({}, null),
      chunk({ content: '' }, null),
      chunk({ reasoning: 'weather", "arguments": {"city": "Lima"}}\n</tool_call>\n< response>\n' }),
      chunk({}, 'stop'),
    ]),
    { engineHint: 'vllm', engineVersion: '0.19.0' }
  );
  assert.equal(result.detected, true);
  assert.equal(result.pattern, 'A');
  assert.deepEqual(result.toolCall, { name: 'get_weather', arguments: { city: 'Lima' } });
});
