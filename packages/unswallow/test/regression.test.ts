import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkAndRescue, createProxyServer, type RawProviderResponse } from '../dist/src/index';

function swallowed(reasoning: string): RawProviderResponse {
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', reasoning, tool_calls: [] } }] };
}
const fn = (v: string) => `<tool_call>\n<function=search>\n<parameter=q>${v}</parameter>\n</function>\n</tool_call>`;

// --- recover.ts: findClose must search from `from`, not from index 0 ---------------------
for (const n of [2, 3]) {
  test(`${n} parallel <function=> envelopes in one region are all recovered`, () => {
    const calls = Array.from({ length: n }, (_, i) => fn('q' + i)).join('\n');
    const r = checkAndRescue(swallowed(`<thinking>\nParallel searches.\n${calls}\n</thinking>`), {});
    assert.equal(r.toolCalls!.length, n);
    assert.equal(r.recovered, true);
    assert.equal(r.recoveredCalls!.length, n);
  });
}

// --- proxy helpers -----------------------------------------------------------------------
type Sse = Record<string, unknown>;
async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as { port: number }).port;
}
const close = (s: http.Server) => new Promise<void>((resolve) => s.close(() => resolve()));

function streamingUpstream(chunks: Sse[]): http.Server {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
}
async function sseEvents(res: Response): Promise<Sse[]> {
  return (await res.text()).split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(5)));
}
const post = (port: number, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('proxy streaming emits only gate-passing calls (rehearsed Oslo blocked, Kyoto recovered)', async () => {
  const reh = '{"name": "get_weather", "arguments": {"city": "Oslo"}}';
  const gen = '{"name": "get_weather", "arguments": {"city": "Kyoto"}}';
  const prose = 'That was only a draft of what the call might look like, and after reconsidering the user request I will now decide on the final approach and continue carefully.';
  const reasoning = `<thinking>\nWorking through options.\n${reh}\n${prose}\n${gen}\n</thinking>`;
  const upstream = streamingUpstream([
    { id: 'x', choices: [{ index: 0, finish_reason: null, delta: { reasoning } }] },
    { id: 'x', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] },
  ]);
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${await listen(upstream)}` });
  try {
    const events = await sseEvents(await post(await listen(proxy), { model: 'm', messages: [], stream: true }));
    const cities = events
      .filter((e: any) => e.choices?.[0]?.delta?.tool_calls)
      .map((e: any) => JSON.parse(e.choices[0].delta.tool_calls[0].function.arguments).city);
    assert.deepEqual(cities, ['Kyoto']);
  } finally { await close(proxy); await close(upstream); }
});

test('a stream larger than the accumulator guard is forwarded, does not crash the proxy, and skips recovery', async () => {
  const filler = 'x'.repeat(1000);
  const chunks: Sse[] = Array.from({ length: 1100 }, () => ({ id: 'big', choices: [{ index: 0, finish_reason: null, delta: { content: filler } }] }));
  chunks.push({ id: 'big', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] });
  const upstream = streamingUpstream(chunks);
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${await listen(upstream)}` });
  try {
    const port = await listen(proxy);
    const res = await post(port, { model: 'm', messages: [], stream: true });
    const text = await res.text();
    assert.ok(text.includes('data: [DONE]'), 'client still receives a terminated stream');
    const again = await post(port, { model: 'm', messages: [], stream: true });
    assert.equal(again.status, 200, 'proxy is still alive for the next request');
    await again.text();
  } finally { await close(proxy); await close(upstream); }
});

// --- requestAware (opt-in) ---------------------------------------------------------------
const SWALLOWED = {
  id: 'c', object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: [],
    reasoning: '<thinking>\nNeed weather.\n<tool_call>{"name": "get_weather", "arguments": {"city": "Tokyo"}}</tool_call>\n</thinking>' } }],
};
const WEATHER_TOOL = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };

async function xUnswallow(requestAware: boolean, body: Record<string, unknown>) {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(SWALLOWED)); }); });
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${await listen(upstream)}`, requestAware });
  try {
    const res = await post(await listen(proxy), { model: 'm', messages: [], ...body });
    await res.text();
    return JSON.parse(res.headers.get('x-unswallow') ?? '{}');
  } finally { await close(proxy); await close(upstream); }
}
test('requestAware: request with no tools does not get a tool call fabricated', async () => {
  assert.equal((await xUnswallow(true, {})).recovered, false);
  assert.equal((await xUnswallow(true, { tools: [WEATHER_TOOL], tool_choice: 'none' })).recovered, false);
});
test('requestAware: request offering the tool recovers; a tool not offered is withheld', async () => {
  assert.equal((await xUnswallow(true, { tools: [WEATHER_TOOL] })).recovered, true);
  assert.equal((await xUnswallow(true, { tools: [{ ...WEATHER_TOOL, function: { ...WEATHER_TOOL.function, name: 'get_news' } }] })).recovered, false);
});
test('requestAware is off by default: behavior unchanged for requests without tools', async () => {
  assert.equal((await xUnswallow(false, {})).recovered, true);
});

// --- observeOnly + richer x-unswallow header ---------------------------------------------
test('x-unswallow header reports category and blocked count', async () => {
  const h = await xUnswallow(false, {});
  assert.equal(h.category, 'swallowed_tool_call');
  assert.equal(h.blocked, 0);
  assert.equal(h.observeOnly, false);
});

test('observeOnly (non-streaming): detects and reports, but returns the upstream response unmodified', async () => {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(SWALLOWED)); }); });
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${await listen(upstream)}`, observeOnly: true });
  try {
    const res = await post(await listen(proxy), { model: 'm', messages: [] });
    const header = JSON.parse(res.headers.get('x-unswallow') ?? '{}');
    const body: any = await res.json();
    assert.equal(header.detected, true);
    assert.equal(header.observeOnly, true);
    assert.deepEqual(body.choices[0].message.tool_calls, []);
    assert.equal(body.choices[0].finish_reason, 'stop');
  } finally { await close(proxy); await close(upstream); }
});

test('observeOnly (streaming): no tool_calls chunk is emitted and the original finish_reason is preserved', async () => {
  const reasoning = SWALLOWED.choices[0].message.reasoning;
  const upstream = streamingUpstream([
    { id: 'x', choices: [{ index: 0, finish_reason: null, delta: { reasoning } }] },
    { id: 'x', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] },
  ]);
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${await listen(upstream)}`, observeOnly: true });
  try {
    const events: any[] = await sseEvents(await post(await listen(proxy), { model: 'm', messages: [], stream: true }));
    assert.equal(events.filter((e) => e.choices?.[0]?.delta?.tool_calls).length, 0);
    assert.equal(events.find((e) => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
    assert.equal(events.find((e) => e.x_unswallow)?.x_unswallow.observeOnly, true);
  } finally { await close(proxy); await close(upstream); }
});
