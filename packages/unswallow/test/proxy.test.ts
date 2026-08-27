import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../dist/src/index';

const SWALLOWED_RESPONSE = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  model: 'Qwen/Qwen3.5-35B-A3B-FP8',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        reasoning:
          '< thinking>\nI need the weather.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n',
        tool_calls: [],
      },
    },
  ],
};

const CLEAN_RESPONSE = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  model: 'Qwen/Qwen3.5-35B-A3B-FP8',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city": "Tokyo"}' },
          },
        ],
      },
    },
  ],
};

function upstreamServer(overrideResponse?: unknown) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const isStream = payload.stream === true;
      if (isStream) {
        const chunks = [
          { id: 'chatcmpl-up', object: 'chat.completion.chunk', choices: [{ index: 0, finish_reason: null, delta: { reasoning: '< thin' } }] },
          { id: 'chatcmpl-up', object: 'chat.completion.chunk', choices: [{ index: 0, finish_reason: null, delta: { reasoning: 'king>\n<tool_call>{"name": "get_weather", "arguments": {"city": "Tokyo"}}</tool_call>\n< response>\n' } }] },
          { id: 'chatcmpl-up', object: 'chat.completion.chunk', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(overrideResponse ?? SWALLOWED_RESPONSE));
    });
  });
  return new Promise<http.Server>((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function start(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return `http://127.0.0.1:${addr.port}`;
}

function stop(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('proxy recovers a swallowed non-streaming response', async () => {
  const upstream = await upstreamServer();
  const proxy = createProxyServer({
    upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  const base = await start(proxy);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const xUnswallow = JSON.parse(res.headers.get('x-unswallow') ?? '{}');
    assert.equal(xUnswallow.detected, true);
    assert.equal(xUnswallow.pattern, 'A');
    assert.equal(xUnswallow.recovered, true);
    assert.equal(xUnswallow.confidence, 0.95);
    const body = (await res.json()) as typeof SWALLOWED_RESPONSE;
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
  } finally {
    await stop(proxy);
    await stop(upstream);
  }
});

test('proxy passes healthy responses through untouched', async () => {
  const upstream = await upstreamServer(CLEAN_RESPONSE);
  const proxy = createProxyServer({
    upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
  });
  const base = await start(proxy);
  try {
const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
    });
    const xUnswallow = JSON.parse(res.headers.get('x-unswallow') ?? '{}');
    assert.equal(xUnswallow.detected, false);
    const body = (await res.json()) as typeof CLEAN_RESPONSE;
    assert.deepEqual(body, CLEAN_RESPONSE);
  } finally {
    await stop(proxy);
    await stop(upstream);
  }
});

test('proxy appends recovery tail to streaming responses and drops the stale stop chunk', async () => {
  const upstream = await upstreamServer();
  const proxy = createProxyServer({
    upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    engineHint: 'vllm',
    engineVersion: '0.19.0',
  });
  const base = await start(proxy);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(res.headers.get('content-type') ?? '', 'text/event-stream');
    const text = await res.text();
    const events = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:') && l.trim() !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(5).trim()));
    const toolCallChunk = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
    const finishChunk = events.find((e) => e.choices?.[0]?.finish_reason);
    const diag = events.find((e) => e.x_unswallow);
    assert.ok(toolCallChunk, 'recovery delta chunk present');
    assert.equal(toolCallChunk.choices[0].delta.tool_calls[0].function.name, 'get_weather');
    assert.ok(finishChunk, 'finish chunk present');
    assert.equal(finishChunk.choices[0].finish_reason, 'tool_calls');
    assert.equal(events.filter((e) => e.choices?.[0]?.finish_reason === 'stop').length, 0, 'stale stop chunk suppressed');
    assert.ok(diag, 'diagnostics event present');
    assert.equal(diag.x_unswallow.recovered, true);
  } finally {
    await stop(proxy);
    await stop(upstream);
  }
});

test('proxy passes non-chat routes through', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
  const base = await start(proxy);
  try {
    const res = await fetch(`${base}/v1/models`);
    const body = (await res.json()) as { path: string };
    assert.equal(body.path, '/v1/models');
  } finally {
    await stop(proxy);
    await stop(upstream);
  }
});
