import { performance } from 'node:perf_hooks';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../unswallow/dist/src/index.js');
const { checkAndRescue, checkAndRescueStream, sanitizeHistory, matchMatrixEntry, extractAllEnvelopes, createStreamAccumulator } = core;
const matrixEntries = require('unswallow-matrix').entries;

const RESULTS_DIR = path.join(import.meta.dirname, 'perf');
const RESULTS_MD = path.join(RESULTS_DIR, 'results.md');
const RESULTS_JSON = path.join(RESULTS_DIR, 'results.json');

const WORDS = [
  'the', 'user', 'asked', 'about', 'weather', 'tokyo', 'berlin', 'need', 'call', 'tool',
  'reasoning', 'carefully', 'check', 'arguments', 'city', 'temperature', 'report', 'answer',
  'first', 'should', 'use', 'get_weather', 'function', 'parse', 'result', 'then', 'final',
  'consider', 'likely', 'state', 'require', 'estimate', 'slight', 'chance', 'forecast',
  'humidity', 'wind', 'northwest', 'degrees', 'celsius', 'clear', 'cloudy', 'evening',
  'morning', 'summary', 'request', 'details', 'source', 'verify', 'values', 'exact',
  'roughly', 'approximately', 'decide', 'plan', 'approach', 'correct', 'fields', 'schema',
];
const CITIES = ['Tokyo', 'Berlin', 'Paris', 'Oslo', 'Shanghai', 'Kyoto', 'Rome', 'Beijing', 'Hangzhou', 'Oslo'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeText(rng, targetBytes) {
  let out = '';
  while (Buffer.byteLength(out) < targetBytes) {
    const n = 6 + Math.floor(rng() * 14);
    const words = [];
    for (let i = 0; i < n; i++) words.push(WORDS[(rng() * WORDS.length) | 0]);
    out += words.join(' ') + '.\n';
  }
  return out;
}

function makePayload(rng, scenario) {
  const city = CITIES[(rng() * CITIES.length) | 0];
  switch (scenario) {
    case 'a-small':
      return {
        model: 'Qwen/Qwen3.5-35B-A3B-FP8',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            reasoning:
              '< thinking>\n' + makeText(rng, 2000 + rng() * 1000) +
              '<tool_call>\n{"name": "get_weather", "arguments": {"city": "' + city + '"}}\n</tool_call>\n< response>\n',
            tool_calls: [],
          },
        }],
      };
    case 'a-large':
      return {
        model: 'Qwen/Qwen3.5-35B-A3B-FP8',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            reasoning:
              '< thinking>\n' + makeText(rng, 64000) +
              '<tool_call>\n{"name": "get_weather", "arguments": {"city": "' + city + '"}}\n</tool_call>\n< response>\n',
            tool_calls: [],
          },
        }],
      };
    case 'a-huge':
      return {
        model: 'Qwen/Qwen3.5-35B-A3B-FP8',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            reasoning:
              '< thinking>\n' + makeText(rng, 1_000_000) +
              '<tool_call>\n{"name": "get_weather", "arguments": {"city": "' + city + '"}}\n</tool_call>\n< response>\n',
            tool_calls: [],
          },
        }],
      };
    case 'a-xml':
      return {
        model: 'Qwen/Qwen3.5-35B-A3B-FP8',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            reasoning:
              '< thinking>\n' + makeText(rng, 1500) +
              '<tool_call>\n<function=get_weather>\n<parameter=city>\n' + city + '\n</parameter>\n</function>\n</tool_call>\n< response>\n',
            tool_calls: [],
          },
        }],
      };
    case 'b-trailing':
      return {
        model: 'Kimi-K2-Thinking',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content:
              '{"name": "get_weather", "arguments": {"city": "' + city + '"}}\n\n' +
              makeText(rng, 800),
            tool_calls: [],
          },
        }],
      };
    case 'c-leak':
      return {
        model: 'MiniMax-M3',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Here is the summary. <mm:think>' + makeText(rng, 300),
            tool_calls: [],
          },
        }],
      };
    case 'clean':
      return {
        model: 'Qwen/Qwen3.5-35B-A3B-FP8',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            reasoning: '< thinking>\n' + makeText(rng, 800) + '\n< response>\n',
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city": "' + city + '"}' },
            }],
          },
        }],
      };
    case 'fp-discussion':
      return {
        model: 'Qwen/Qwen3.5-35B-A3B-FP8',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            reasoning:
              '< thinking>\nI could call get_weather for ' + city + ' but no tool result is required here.\n' +
              makeText(rng, 1200) + '\n< response>\n',
            tool_calls: [],
          },
        }],
      };
    default:
      throw new Error('unknown scenario ' + scenario);
  }
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function meanOf(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function medianOf(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Repeat-run measurement: `runs` full passes, each with its own warmup and
 * `iterations` samples. Percentiles come from the pooled samples; the reported
 * mean is the median of the per-run means, with the per-run spread (min–max)
 * reported so a single noisy run is visible instead of hidden.
 */
function measure(fn, iterations, warmup = 200, runs = 5) {
  const perRunMeans = [];
  const pooled = [];
  for (let r = 0; r < runs; r++) {
    for (let i = 0; i < warmup; i++) fn();
    const samples = new Float64Array(iterations);
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      fn();
      samples[i] = performance.now() - t0;
    }
    pooled.push(...samples);
    perRunMeans.push(meanOf(samples));
  }
  const sorted = pooled.sort((a, b) => a - b);
  const mean = medianOf(perRunMeans);
  return {
    n: iterations * runs,
    runs,
    perRunN: iterations,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean,
    meanMin: Math.min(...perRunMeans),
    meanMax: Math.max(...perRunMeans),
    perRunMeans,
    opsPerSec: 1000 / mean,
  };
}

async function measureAsync(fn, iterations, warmup = 50, runs = 3) {
  const perRunMeans = [];
  const pooled = [];
  for (let r = 0; r < runs; r++) {
    for (let i = 0; i < warmup; i++) await fn();
    const samples = new Float64Array(iterations);
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      await fn();
      samples[i] = performance.now() - t0;
    }
    pooled.push(...samples);
    perRunMeans.push(meanOf(samples));
  }
  const sorted = pooled.sort((a, b) => a - b);
  const mean = medianOf(perRunMeans);
  return {
    n: iterations * runs,
    runs,
    perRunN: iterations,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean,
    meanMin: Math.min(...perRunMeans),
    meanMax: Math.max(...perRunMeans),
    perRunMeans,
    opsPerSec: 1000 / mean,
  };
}

function measureRetained(fn, iterations) {
  if (typeof global.gc !== 'function') return null;
  fn();
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i++) fn();
  global.gc();
  const after = process.memoryUsage().heapUsed;
  const retained = Math.max(0, after - before);
  return { iterations, retainedBytes: retained, perOpBytes: retained / iterations };
}

function scanBalanced(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function naiveCheck(message) {
  const text = ['reasoning', 'reasoning_content', 'thinking', 'thought', 'content']
    .map((f) => (typeof message[f] === 'string' ? message[f] : ''))
    .join('\n');
  if (!/<tool_call>|<function=|\{"name"\s*:/.test(text)) return { found: false, name: null };
  const i = text.indexOf('{');
  if (i === -1) return { found: true, name: null };
  const end = scanBalanced(text, i);
  if (end === -1) return { found: true, name: null };
  try {
    const obj = JSON.parse(text.slice(i, end));
    const name = obj && (obj.name ?? obj.function?.name);
    return { found: true, name: typeof name === 'string' ? name : null };
  } catch {
    return { found: true, name: null };
  }
}

/**
 * Component probes backing the README's Python-vs-TypeScript divergence
 * paragraph — each is a single, directly comparable mechanism, measured on
 * the same 1 MB payload the synthetic scenario uses.
 */
function probeClone(payload) {
  return structuredClone(payload);
}

function probeScan(reasoningText) {
  return extractAllEnvelopes(reasoningText);
}

function probeTrackerLoop(chunks) {
  const acc = createStreamAccumulator();
  for (const c of chunks) acc.push(c);
  return acc;
}

const SCENARIOS = [
  { key: 'a-small', label: 'Pattern A — small reasoning (~2–3KB)', iters: 3000, retained: 2000 },
  { key: 'a-xml', label: 'Pattern A — function-XML envelope (~1.5KB)', iters: 3000, retained: 2000 },
  { key: 'a-large', label: 'Pattern A — large reasoning (64KB)', iters: 500, retained: 200 },
  { key: 'a-huge', label: 'Pattern A — 1MB reasoning', iters: 100, retained: 50 },
  { key: 'b-trailing', label: 'Pattern B — trailing text in content', iters: 2000, retained: 1000 },
  { key: 'c-leak', label: 'Pattern C — field leak (detection-only)', iters: 2000, retained: 1000 },
  { key: 'clean', label: 'Healthy — tool_calls already populated', iters: 2000, retained: 1000 },
  { key: 'fp-discussion', label: 'False-positive guard — discussion-only', iters: 2000, retained: 1000 },
];

async function measureProxy() {
  const http = (await import('node:http')).default;
  const { createProxyServer } = require('../unswallow/dist/src/index.js');

  const SWALLOWED = {
    id: 'up', object: 'chat.completion', model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', message: { content: '', reasoning: '< thinking>\n<tool_call>{"name": "get_weather", "arguments": {"city": "Tokyo"}}</tool_call>\n< response>\n', tool_calls: [] } }],
  };
  const CLEAN = {
    id: 'up', object: 'chat.completion', model: 'm',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city": "Tokyo"}' } }] } }],
  };

  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = [
          { id: 'up', choices: [{ index: 0, finish_reason: null, delta: { reasoning: '< thin' } }] },
          { id: 'up', choices: [{ index: 0, finish_reason: null, delta: { reasoning: 'king>\n<tool_call>{"name": "get_weather", "arguments": {"city": "Tokyo"}}</tool_call>\n< response>\n' } }] },
          { id: 'up', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] },
        ];
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const out = payload.tools && payload.tools.length > 0 ? SWALLOWED : CLEAN;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r()));
  const close = (s) => new Promise((r) => s.close(() => r()));
  await listen(upstream);
  const upBase = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = createProxyServer({ upstream: upBase, engineHint: 'vllm', engineVersion: '0.19.0' });
  await listen(proxy);
  const proxyBase = `http://127.0.0.1:${proxy.address().port}`;

  const roundtrip = (base, body) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.arrayBuffer());

  const mkBody = (swallowed) => ({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    ...(swallowed ? { tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }] } : {}),
  });

  const rows = [];
  const cases = [
    ['non-stream, swallowed (recovered)', mkBody(true), false],
    ['non-stream, healthy (passthrough)', mkBody(false), false],
    ['streaming, swallowed (recovery tail)', mkBody(true), true],
  ];
  for (const [label, body, isStream] of cases) {
    const reqBody = isStream ? { ...body, stream: true } : body;
    const direct = await measureAsync(() => roundtrip(upBase, reqBody), 60, 10);
    const viaProxy = await measureAsync(() => roundtrip(proxyBase, reqBody), 60, 10);
    rows.push({ label, directMs: direct.mean, proxyMs: viaProxy.mean, overheadMs: viaProxy.mean - direct.mean });
  }
  await close(proxy);
  await close(upstream);
  return rows;
}

async function main() {
  const rng = mulberry32(0x756e7377);
  const streamIterable = (chunks) => {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c;
      },
    };
  };
  const payloads = {};
  const sizes = {};
  for (const s of SCENARIOS) {
    payloads[s.key] = [];
    sizes[s.key] = 0;
    for (let i = 0; i < 50; i++) {
      const p = makePayload(rng, s.key);
      payloads[s.key].push(p);
      sizes[s.key] += Buffer.byteLength(JSON.stringify(p));
    }
    sizes[s.key] = Math.round(sizes[s.key] / 50);
  }
  // Cross-language corpus identity: the Python harness must produce the same
  // hash, or the "same seeds, same payloads" comparison guarantee is broken.
  const corpusHash = createHash('sha256').update(JSON.stringify(payloads['a-small'])).digest('hex');

  const checkRows = [];
  for (const s of SCENARIOS) {
    const iters = s.iters;
    const pool = payloads[s.key];
    let i = 0;
    const res = measure(() => checkAndRescue(pool[i++ % pool.length]), iters);
    const retained = measureRetained(() => checkAndRescue(pool[(i++ * 7) % pool.length]), s.retained);
    checkRows.push({
      scenario: s.key,
      label: s.label,
      payloadBytes: sizes[s.key],
      n: res.n,
      runs: res.runs,
      p50ms: res.p50,
      p95ms: res.p95,
      p99ms: res.p99,
      meanMs: res.mean,
      meanMin: res.meanMin,
      meanMax: res.meanMax,
      perRunMeans: res.perRunMeans,
      opsPerSec: res.opsPerSec,
      retainedPerOpBytes: retained ? retained.perOpBytes : null,
    });
  }

  const baselineRows = [];
  for (const s of SCENARIOS) {
    const pool = payloads[s.key];
    let i = 0;
    const res = measure(() => naiveCheck(pool[i++ % pool.length].choices[0].message), Math.min(s.iters, 2000));
    baselineRows.push({ scenario: s.key, label: s.label, n: res.n, meanMs: res.mean, meanMin: res.meanMin, meanMax: res.meanMax, perRunMeans: res.perRunMeans, opsPerSec: res.opsPerSec });
  }

  const baselineFp = [];
  {
    const fpDir = path.join(import.meta.dirname, 'fixtures');
    const fpFiles = fs.readdirSync(fpDir).filter((f) => f.startsWith('fp-guard'));
    for (const f of fpFiles) {
      const fixture = JSON.parse(fs.readFileSync(path.join(fpDir, f), 'utf8'));
      const message = fixture.response.choices[0].message;
      const naive = naiveCheck(message);
      baselineFp.push({ id: fixture.id ?? f, naiveFired: naive.found });
    }
  }

  // Real fixture corpus — the pinned upstream-derived shapes, same harness.
  const fixtureRows = [];
  {
    const fixDir = path.join(import.meta.dirname, 'fixtures');
    const files = fs.readdirSync(fixDir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const fixture = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
      const fid = fixture.id ?? fixture.response?.id ?? f;
      const opts = { engineHint: fixture.engine, engineVersion: fixture.version };
      const payloadBytes = Buffer.byteLength(JSON.stringify(fixture.response ?? fixture.chunks ?? {}));
      let res;
      if (fixture.stream) {
        const chunks = fixture.chunks ?? [];
        res = await measureAsync(() => checkAndRescueStream(streamIterable(chunks), opts), 200, 20, 3);
      } else {
        const iters = Math.max(100, Math.min(3000, Math.round(2_000_000 / Math.max(1, payloadBytes))));
        res = measure(() => checkAndRescue(fixture.response, opts), iters, 100, 3);
      }
      fixtureRows.push({ id: fid, stream: !!fixture.stream, payloadBytes, ...res });
    }
  }

  const streamChunks = [];
  {
    const srng = mulberry32(0x53747265);
    const reasoning =
      '< thinking>\n' + makeText(srng, 20000) +
      '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n';
    const piece = (start) => reasoning.slice(start, start + 24);
    for (let i = 0; i < reasoning.length; i += 24) {
      streamChunks.push({ choices: [{ index: 0, finish_reason: null, delta: { reasoning: piece(i) } }] });
    }
    streamChunks.push({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] });
  }
  const streamRes = await measureAsync(
    () => checkAndRescueStream(streamIterable(streamChunks), { engineHint: 'vllm', engineVersion: '0.19.0' }),
    300
  );

  const trackerLoopRes = measure(
    () => probeTrackerLoop(streamChunks),
    200,
    50,
    3
  );
  const assembled = streamChunks.reduce((acc, c) => {
    const d = c.choices?.[0]?.delta ?? {};
    for (const f of ['reasoning', 'content']) if (d[f]) acc[f] = (acc[f] ?? '') + d[f];
    return acc;
  }, {});
  const nonStreamRes = measure(() => checkAndRescue({
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', reasoning: assembled.reasoning, content: assembled.content ?? '', tool_calls: [] } }],
  }, { engineHint: 'vllm', engineVersion: '0.19.0' }), 2000);

  const bigChunks = [];
  {
    const brng = mulberry32(0x426967);
    let text = '';
    while (Buffer.byteLength(text) < 500000) text += makeText(brng, 30000);
    for (let i = 0; i < text.length; i += 96) {
      bigChunks.push({ choices: [{ index: 0, finish_reason: null, delta: { content: text.slice(i, i + 96) } }] });
    }
    bigChunks.push({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] });
  }
  const bigStreamRes = await measureAsync(
    () => checkAndRescueStream(streamIterable(bigChunks)),
    120
  );

  const history = [];
  {
    const hrng = mulberry32(0x48697374);
    for (let i = 0; i < 40; i++) {
      history.push({
        role: i % 3 === 0 ? 'user' : 'assistant',
        content:
          i % 2 === 0
            ? '< thinking>\n' + makeText(hrng, 400) + '\n< response>\n' + makeText(hrng, 200)
            : makeText(hrng, 300),
        ...(i % 3 === 1 ? { reasoning: '< thinking>\n' + makeText(hrng, 400) + '\n< response>\n' } : {}),
      });
    }
  }
  const historyRes = measure(() => sanitizeHistory(history), 3000);

  const matrixTuples = [];
  {
    const mrng = mulberry32(0x4d6174);
    const engines = ['vllm', 'sglang', 'llama.cpp'];
    const versions = ['0.19.0', '0.23.4', '0.24.0', '0.26.0', '0.4.6', 'b8461', '1.0.0'];
    const patterns = ['A', 'B', 'C'];
    for (let i = 0; i < 100000; i++) {
      matrixTuples.push([
        engines[(mrng() * engines.length) | 0],
        versions[(mrng() * versions.length) | 0],
        patterns[(mrng() * patterns.length) | 0],
      ]);
    }
  }
  let mi = 0;
  const matrixRes = measure(() => {
    const [e, v, p] = matrixTuples[mi++ % matrixTuples.length];
    matchMatrixEntry(matrixEntries, e, v, p);
  }, 100000);

  const refRes = measure(() => {
    const p = payloads['a-large'][0];
    JSON.parse(JSON.stringify(p));
  }, 500, 100, 3);

  // Component probes — the mechanisms cited in the README's divergence note.
  const hugePayload = payloads['a-huge'][0];
  const hugeReasoning = hugePayload.choices[0].message.reasoning;
  const cloneRes = measure(() => probeClone(hugePayload), 200, 50, 3);
  const scanRes = measure(() => probeScan(hugeReasoning), 300, 50, 3);
  const probes = { clone: cloneRes, scan: scanRes, trackerLoop: trackerLoopRes };
  const probesCtx = {
    clonePayloadBytes: Buffer.byteLength(JSON.stringify(hugePayload)),
    scanBytes: Buffer.byteLength(hugeReasoning),
    trackerChunks: streamChunks.length - 1,
    streamTotalMs: streamRes.mean,
  };

  const proxyRows = await measureProxy();

  const machine = {
    platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    totalMemBytes: os.totalmem(),
    node: process.version,
    date: new Date().toISOString(),
    gcAvailable: typeof global.gc === 'function',
  };

  const fmt = (r) =>
    `${(r.p50ms ?? r.p50).toFixed(2)} / ${(r.p95ms ?? r.p95).toFixed(2)} / ${(r.p99ms ?? r.p99).toFixed(2)} ms`;
  const fmtSpread = (r) =>
    `${(r.meanMs ?? r.mean).toFixed(3)} ms (${(r.meanMin ?? r.mean).toFixed(3)}–${(r.meanMax ?? r.mean).toFixed(3)})`;
  const fmtOps = (r) => `${r.opsPerSec.toLocaleString('en-US', { maximumFractionDigits: 0 })} ops/s`;

  const md = [
    '# unswallow — performance report',
    '',
    `measured ${machine.date} · ${machine.node} · ${machine.platform} · ${machine.cpu} (${machine.cores} cores) · ${(machine.totalMemBytes / 1024 / 1024 / 1024).toFixed(1)} GB RAM${machine.gcAvailable ? '' : ' (run with `node --expose-gc` for memory numbers)'}`,
    '',
    'Reproduce on your own hardware: `npm run bench:perf`. Seeded, deterministic corpus; results are wall-clock on an unloaded-ish dev machine — treat cross-machine comparisons with care.',
    '',
    'Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean.',
    '',
    `Corpus identity: sha256 of the a-small payload pool is ${corpusHash} — the Python report must carry the same hash (cross-language "same seeds, same payloads" check).`,
    '',
    '## checkAndRescue — latency per call (warm)',
    '',
    '| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...checkRows.map((r) =>
      `| ${r.label} | ${(r.payloadBytes / 1024).toFixed(1)} KB | ${r.n} | ${fmt(r)} | ${fmtSpread(r)} | ${fmtOps(r)} | ${r.retainedPerOpBytes !== null ? (r.retainedPerOpBytes / 1024).toFixed(2) + ' KB' : 'n/a' } |`
    ),
    '',
    '## Streaming (checkAndRescueStream)',
    '',
    '| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |',
    '| --- | --- | --- | --- | --- |',
    `| typical reasoning stream, envelope split across deltas | ${streamChunks.length - 1} | ${(streamChunks.reduce((s, c) => s + Buffer.byteLength(c.choices?.[0]?.delta?.reasoning ?? c.choices?.[0]?.delta?.content ?? ''), 0) / 1024).toFixed(1)} KB | ${fmt(streamRes)} | ${fmtSpread(streamRes)} |`,
    `| 500 KB content stream | ${bigChunks.length - 1} | 500.0 KB | ${fmt(bigStreamRes)} | ${fmtSpread(bigStreamRes)} |`,
    `| reference: same message, non-streaming checkAndRescue | — | — | ${fmt(nonStreamRes)} | ${fmtSpread(nonStreamRes)} |`,
    '',
    '## Component probes (why TS and Python diverge)',
    '',
    'The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).',
    '',
    '| probe | payload | n | mean (min–max) |',
    '| --- | --- | --- | --- |',
    `| deep copy of 1 MB payload (structuredClone) | ${(probesCtx.clonePayloadBytes / 1024).toFixed(1)} KB | ${cloneRes.n} | ${fmtSpread(cloneRes)} |`,
    `| envelope scan of 1 MB reasoning (extractAllEnvelopes) | ${(probesCtx.scanBytes / 1024).toFixed(1)} KB | ${scanRes.n} | ${fmtSpread(scanRes)} |`,
    `| leak-tracker loop, ${probesCtx.trackerChunks} chunk pushes (${(streamChunks.reduce((s, c) => s + Buffer.byteLength(c.choices?.[0]?.delta?.reasoning ?? ''), 0) / 1024).toFixed(1)} KB) | — | ${trackerLoopRes.n} | ${fmtSpread(trackerLoopRes)} |`,
    '',
    '## Pattern D — sanitizeHistory',
    '',
    `| corpus | p50 / p95 / p99 | mean (min–max) | throughput |`,
    `| --- | --- | --- | --- |`,
    `| 40-message history with leaked reasoning | ${fmt(historyRes)} | ${fmtSpread(historyRes)} | ${fmtOps(historyRes)} |`,
    '',
    '## Matrix lookup — matchMatrixEntry',
    '',
    `| workload | p50 / p95 / p99 | mean (min–max) | throughput |`,
    `| --- | --- | --- | --- |`,
    `| 100k lookups (engine/version/pattern) | ${fmt(matrixRes)} | ${fmtSpread(matrixRes)} | ${fmtOps(matrixRes)} |`,
    '',    '## Reference point',
    '',
    '| workload | mean (min–max) |',
    '| --- | --- |',
    `| JSON.parse(JSON.stringify(payload)) of the 64KB pattern-A payload | ${fmtSpread(refRes)} |`,
    '',
    '## Proxy overhead (loopback, in-process upstream)',
    '',
    '| case | direct | via proxy | added |',
    '| --- | --- | --- | --- |',
    ...proxyRows.map((r) => `| ${r.label} | ${r.directMs.toFixed(2)} ms | ${r.proxyMs.toFixed(2)} ms | +${r.overheadMs.toFixed(2)} ms |`),
    '',
    '## Naive baseline (marker scan, no validation, no recovery)',
    '',
    'What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `JSON.parse` attempt, no envelope validation, no false-positive guard, nothing recovered. The guard fixtures below show what that simplicity costs in correctness.',
    '',
    '| scenario | mean (min–max) | throughput |',
    '| --- | --- | --- |',
    ...baselineRows.map((r) => `| ${r.label} | ${fmtSpread(r)} | ${fmtOps(r)} |`),
    '',
    `False positives on the pinned guard fixtures (naive fired where nothing should recover): ${baselineFp.filter((f) => f.naiveFired).length}/${baselineFp.length} (${baselineFp.filter((f) => f.naiveFired).map((f) => f.id).join(', ') || 'none'})`,
    '',
    '## Real fixture corpus (pinned upstream-derived shapes)',
    '',
    'The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.',
    '',
    '| fixture | stream | payload | n | mean (min–max) | throughput |',
    '| --- | --- | --- | --- | --- | --- |',
    ...fixtureRows.map((r) => `| ${r.id} | ${r.stream ? 'yes' : 'no'} | ${(r.payloadBytes / 1024).toFixed(1)} KB | ${r.n} | ${fmtSpread(r)} | ${fmtOps(r)} |`),
    '',
  ].join('\n');

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_MD, md);
  fs.writeFileSync(
    RESULTS_JSON,
    JSON.stringify({ machine, corpusHash, checkAndRescue: checkRows, baseline: baselineRows, baselineFp, streaming: { typical: streamRes, big: bigStreamRes, nonStreamReference: nonStreamRes }, history: historyRes, matrix: matrixRes, reference: refRes, proxy: proxyRows, probes, probesCtx, fixtures: fixtureRows }, null, 2) + '\n'
  );

  console.log(md);
  console.log('report written to packages/bench/perf/');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});