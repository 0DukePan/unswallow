import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cliPath = path.resolve('packages/unswallow/dist/cli/index.js');

function swallowedResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-cli-test',
    object: 'chat.completion',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        reasoning: '<thinking>Use weather.</thinking><tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>',
        tool_calls: [],
      },
    }],
  };
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('inspect --json exposes schema version and validation results', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unswallow-cli-'));
  try {
    const responseFile = path.join(directory, 'response.json');
    const schemaFile = path.join(directory, 'tools.json');
    fs.writeFileSync(responseFile, JSON.stringify(swallowedResponse()));
    fs.writeFileSync(schemaFile, JSON.stringify({ tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }] }));

    const result = await runCli(['inspect', responseFile, '--schema', schemaFile, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(report.schemaVersion, '1');
    assert.deepEqual(report.validation, {
      structurallyValid: true,
      nameKnown: 'yes',
      schemaValid: 'yes',
      errors: [],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('doctor --out persists the raw response and reports its schema version', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(swallowedResponse()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unswallow-doctor-'));
  const captureFile = path.join(directory, 'capture.json');
  try {
    const result = await runCli([
      'doctor', '--endpoint', `http://127.0.0.1:${address.port}/v1`, '--model', 'test-model',
      '--out', captureFile, '--json',
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(report.schemaVersion, '1');
    assert.equal(report.status, 'recovery-supported');
    assert.equal(report.rawResponseFile, captureFile);
    const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8')) as Record<string, any>;
    assert.deepEqual(capture.response, swallowedResponse());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
