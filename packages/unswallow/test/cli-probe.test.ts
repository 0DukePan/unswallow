import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cliPath = process.env.UNSWALLOW_CLI ?? path.resolve('packages/unswallow/dist/cli/index.js');

const SW = '<thinking>\nNeed weather.\n<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>\n</thinking>';
const HEALTHY = { id: 'h', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] } }] };
const PLAIN = { id: 'p', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'It is sunny in Tokyo today.', tool_calls: [] } }] };
const SWALLOWED = { id: 's', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '', reasoning: SW, tool_calls: [] } }] };

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c; });
    child.stderr.on('data', (c: Buffer) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// The first path segment selects the server behavior: /healthy/v1, /plain/v1, /swallowed/v1, /streamonly/v1, /alternating/v1
function mock() {
  const seen = { authorization: '' as string | undefined, calls: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const mode = (req.url ?? '').split('/')[1];
      seen.authorization = req.headers.authorization;
      seen.calls++;
      const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const sse = (reasoning: string) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 's', choices: [{ index: 0, finish_reason: null, delta: { reasoning } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 's', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
      };
      if (mode === 'healthy') return json(HEALTHY);
      if (mode === 'plain') return json(PLAIN);
      if (mode === 'swallowed') return json(SWALLOWED);
      if (mode === 'streamonly') return body.stream === true ? sse(SW) : json(HEALTHY);
      if (mode === 'alternating') return json(seen.calls % 2 === 1 ? HEALTHY : SWALLOWED);
      res.writeHead(404); res.end('no such mode');
    });
  });
  return { server, seen };
}

async function withMock<T>(fn: (base: (mode: string) => string, seen: { authorization?: string; calls: number }) => Promise<T>): Promise<T> {
  const { server, seen } = mock();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try { return await fn((mode) => `http://127.0.0.1:${port}/${mode}/v1`, seen); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('check --endpoint: healthy server (parsed tool_calls) exits 0 and says so', async () => {
  await withMock(async (url) => {
    const r = await runCli(['check', '--endpoint', url('healthy'), '--model', 'm']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /already carries parsed tool_calls/);
  });
});

test('check --endpoint: a probe that never elicits a tool call is INCONCLUSIVE (exit 4), not "not affected"', async () => {
  await withMock(async (url) => {
    const r = await runCli(['check', '--endpoint', url('plain'), '--model', 'm', '--json']);
    assert.equal(r.code, 4);
    assert.equal(JSON.parse(r.stdout).status, 'inconclusive');
    const human = await runCli(['check', '--endpoint', url('plain'), '--model', 'm']);
    assert.equal(human.code, 4);
    assert.match(human.stdout, /INCONCLUSIVE/);
  });
});

test('check --endpoint: a swallowing server exits 1 with status affected', async () => {
  await withMock(async (url) => {
    const r = await runCli(['check', '--endpoint', url('swallowed'), '--model', 'm', '--json']);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.schemaVersion, '1');
    assert.equal(report.status, 'affected');
    assert.equal(report.recovered, true);
  });
});

test('check --endpoint --stream catches a server that only swallows when streaming', async () => {
  await withMock(async (url) => {
    const plain = await runCli(['check', '--endpoint', url('streamonly'), '--model', 'm']);
    assert.equal(plain.code, 0, 'non-streaming probe alone cannot see this');
    const both = await runCli(['check', '--endpoint', url('streamonly'), '--model', 'm', '--stream', '--json']);
    assert.equal(both.code, 1);
    const report = JSON.parse(both.stdout);
    assert.deepEqual(report.passes.map((p: { mode: string; state: string }) => `${p.mode}:${p.state}`), ['non-streaming:healthy', 'streaming:affected']);
  });
});

test('check --endpoint --samples repeats the probe and reports affected if any sample swallows', async () => {
  await withMock(async (url, seen) => {
    const r = await runCli(['check', '--endpoint', url('alternating'), '--model', 'm', '--samples', '3', '--json']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).passes.length, 3);
    assert.equal(seen.calls, 3);
  });
});

test('API key can come from the environment instead of the command line', async () => {
  await withMock(async (url, seen) => {
    await runCli(['check', '--endpoint', url('healthy'), '--model', 'm'], { UNSWALLOW_API_KEY: 'sekret' });
    assert.equal(seen.authorization, 'Bearer sekret');
  });
});

test('inspect accepts --json before the file argument', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unswallow-cli-probe-'));
  try {
    const file = path.join(dir, 'resp.json');
    fs.writeFileSync(file, JSON.stringify(SWALLOWED));
    const r = await runCli(['inspect', '--json', file]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).detected, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('check --fixture exits 1 on a detected swallow (like inspect); the bundled demo stays exit 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unswallow-cli-fixture-'));
  try {
    const file = path.join(dir, 'resp.json');
    fs.writeFileSync(file, JSON.stringify(SWALLOWED));
    assert.equal((await runCli(['check', '--fixture', file])).code, 1);
    assert.equal((await runCli(['check'])).code, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('matrix --engine accepts the same spellings as normalizeEngine', async () => {
  const r = await runCli(['matrix', '--engine', 'llamacpp', '--json']);
  const entries = JSON.parse(r.stdout).entries as Array<{ engine?: string }>;
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.engine === 'llama.cpp'));
});

test('proxy rejects invalid flag values with a usage error', async () => {
  assert.equal((await runCli(['proxy', '--upstream', 'http://127.0.0.1:1', '--mode', 'bogus'])).code, 3);
  assert.equal((await runCli(['proxy', '--upstream', 'http://127.0.0.1:1', '--min-confidence', '7'])).code, 3);
});
