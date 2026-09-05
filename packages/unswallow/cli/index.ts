#!/usr/bin/env node
import fs from 'node:fs';
import { checkAndRescue, getMatrixFile, startProxy, type SwallowCheckResult } from '../src/index';
import { demoFixture } from './demo';
import { bar, fg, pad, table } from './format';
import { probeEndpoint } from './probe';

const VERSION = '0.1.3';

const PATTERN_LABELS: Record<string, string> = {
  A: 'trapped inside',
  B: 'trailing after',
  C: 'field leak',
};

function usage(): string {
  return [
    'unswallow — detect & recover tool calls trapped in the reasoning channel',
    '',
    'usage:',
    '  unswallow check [--endpoint <url>] [--model <m>] [--api-key <k>]',
    '                 [--engine <e>] [--version <v>] [--fixture <file>]',
    '                 [--timeout <ms>] [--json]',
    '  unswallow matrix [--engine <e>] [--json]',
    '  unswallow proxy --upstream <url> [--port <p>] [--host <h>] [--prefix <p>]',
    '                  [--engine <e>] [--version <v>]',
    '',
    '  check with no source runs the bundled self-test demo (vLLM #39056 fixture).',
    '  check --endpoint probes a live OpenAI-compatible server for the swallow.',
    '  check --fixture runs against a captured raw response JSON file.',
    '  proxy runs an OpenAI-compatible passthrough that detects and recovers',
    '  the swallow inline — scoped strictly to this bug class.',
    '',
    'exit codes (live probe): 0 = not affected, 1 = affected, 2 = error',
    '',
    'options:',
    '  --engine <vllm|sglang|llama.cpp>   engine hint for matrix-aware confidence',
    '  --version <x.y.z>                  server version for matrix-aware confidence',
    '  --json                             machine-readable output',
  ].join('\n');
}

function renderVerdict(r: SwallowCheckResult, engine: string, version: string): void {
  const line = '─'.repeat(64);
  if (!r.detected) {
    const toolCalls = (r.recoveredResponse ?? { choices: [{ message: {} }] }).choices[0]?.message
      ?.tool_calls;
    const healthy = toolCalls && toolCalls.length > 0;
    console.log(fg.green('✓ NO SWALLOW DETECTED'));
    console.log(healthy
      ? '  response already carries parsed tool_calls — nothing to do.'
      : '  no tool-call envelope found in any reasoning channel.');
    return;
  }
  const pattern = r.pattern ?? '?';
  const banner =
    r.recovered
      ? `${fg.yellow('⚠')} ${fg.bold(fg.yellow(`REASONING-CHANNEL SWALLOW DETECTED — Pattern ${pattern}`))} ${fg.dim(`(${PATTERN_LABELS[pattern]})`)}`
      : `${fg.red('⚠')} ${fg.bold(fg.red(`SWALLOW-LIKE SIGNAL — Pattern ${pattern}`))} ${fg.dim(`(${PATTERN_LABELS[pattern]})`)}`;
  console.log(banner);
  for (const reason of r.warnings.filter((w) => w.includes('tool-call envelope'))) {
    console.log(`  ${fg.dim(reason)}`);
  }
  console.log();
  if (r.recovered && r.recoveredResponse) {
    const calls = r.toolCalls ?? [];
    const before = 'tool_calls: []';
    const after = `tool_calls: [${calls.map((c) => `${c.name}(…)`).join(', ') || '?'}]`;
    const w = Math.max(before.length, after.length) + 2;
    console.log(fg.dim(pad('BEFORE', w)) + fg.green('AFTER'));
    console.log(fg.dim(pad(before, w)) + fg.green(after));
    const fb = 'finish_reason: stop';
    const fa = 'finish_reason: tool_calls';
    console.log(fg.dim(pad(fb, w)) + fg.green(fa));
    console.log();
    for (const call of calls) {
      console.log(
        `  recovered: ${fg.cyan(call.name)}(${JSON.stringify(call.arguments)})`
      );
    }
  } else if (r.pattern === 'C') {
    console.log(`  ${fg.yellow('detection-only — no recovery performed (pattern C, see docs)')}`);
  }
  console.log();
  console.log(`confidence    : ${bar(r.confidence)} ${fg.bold(String(r.confidence.toFixed(2)))}`);
  const matchDesc = r.matrixMatch
    ? `${r.matrixMatch.engine} ${r.matrixMatch.versionRange} → ${r.matrixMatch.behavior}`
    : `none${engine !== 'unknown' ? '' : ' (pass --engine)'}${version ? '' : ' (pass --version)'}`;
  console.log(`matrix match  : ${matchDesc}`);
  if (r.matrixMatch) {
    console.log(`source        : ${fg.dim(r.matrixMatch.source)}`);
    if (r.matrixMatch.fixHint) {
      console.log(`fix hint      : ${fg.dim(r.matrixMatch.fixHint)}`);
    }
  }
  const warnings = r.warnings.filter((w) => !w.startsWith('tool-call envelope'));
  console.log(`warnings      : ${warnings.length === 0 ? '(none)' : ''}`);
  for (const w of warnings) console.log(`                ${fg.yellow(w)}`);
  void line;
}

function readFixtureFile(p: string): {
  response: unknown;
  engineHint?: string;
  engineVersion?: string;
} | null {
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') return null;
  if ('response' in parsed) {
    const hint = (parsed.engineHint ?? parsed.engine) as string | undefined;
    const ver = (parsed.engineVersion ?? parsed.version) as string | number | undefined;
    return {
      response: parsed.response,
      engineHint: typeof hint === 'string' ? hint : undefined,
      engineVersion: ver !== undefined ? String(ver) : undefined,
    };
  }
  return { response: parsed };
}

async function cmdCheck(args: Map<string, string>): Promise<number> {
  const endpoint = args.get('endpoint');
  const fixture = args.get('fixture');
  const json = args.has('json');
  const engine = args.get('engine') ?? '';
  const version = args.get('version') ?? '';

  if (endpoint && fixture) {
    console.error('error: --endpoint and --fixture are mutually exclusive');
    return 3;
  }

  if (endpoint) {
    const model = args.get('model');
    if (!model) {
      console.error('error: --endpoint requires --model');
      return 3;
    }
    const timeout = args.has('timeout') ? parseInt(args.get('timeout')!, 10) : 60000;
    const probe = await probeEndpoint({
      endpoint,
      model,
      apiKey: args.get('api-key'),
      timeoutMs: Number.isFinite(timeout) ? timeout : 60000,
    });
    if (!probe.ok) {
      console.error(`probe failed: ${probe.error}`);
      if (json) {
        console.log(JSON.stringify({ probeOk: false, error: probe.error, status: probe.status ?? null }));
      }
      return 2;
    }
    const result = checkAndRescue(probe.response, {
      engineHint: engine || undefined,
      engineVersion: version || undefined,
      toolSchemas: [],
    });
    if (json) {
      console.log(JSON.stringify({ ...result, probeStatus: probe.status }, null, 2));
      return result.detected ? 1 : 0;
    }
    console.log(`unswallow check — probe ${endpoint}/chat/completions (${probe.status})`);
    console.log(`model         : ${model}`);
    console.log(`engine        : ${engine || 'unknown'}${version ? ' ' + version : ''}`);
    console.log('─'.repeat(64));
    renderVerdict(result, engine, version);
    return result.detected ? 1 : 0;
  }

  let source: unknown;
  let srcDesc: string;
  let engineHint = engine;
  let engineVersion = version;
  if (fixture) {
    let fixtureData: ReturnType<typeof readFixtureFile>;
    try {
      fixtureData = readFixtureFile(fixture);
    } catch (e) {
      console.error(`error: cannot read fixture: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    if (!fixtureData) {
      console.error('error: fixture file is not valid JSON');
      return 2;
    }
    source = fixtureData.response;
    srcDesc = `fixture: ${fixture}`;
    if (fixtureData.engineHint) engineHint = engine || fixtureData.engineHint;
    if (fixtureData.engineVersion) engineVersion = version || fixtureData.engineVersion;
  } else {
    const demo = demoFixture();
    source = demo.response;
    engineHint = engine || demo.engineHint;
    engineVersion = version || demo.engineVersion;
    srcDesc = 'self-test demo (bundled vLLM #39056 fixture)';
  }

  const result = checkAndRescue(source as Parameters<typeof checkAndRescue>[0], {
    engineHint: engineHint || undefined,
    engineVersion: engineVersion || undefined,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`unswallow check — reasoning-channel swallow scan`);
  console.log(`source        : ${srcDesc}`);
  console.log(`engine        : ${engineHint || 'unknown'}${engineVersion ? ' ' + engineVersion : ''}`);
  console.log('─'.repeat(64));
  renderVerdict(result, engineHint, engineVersion);
  return 0;
}

function cmdProxy(args: Map<string, string>): number {
  const upstream = args.get('upstream');
  if (!upstream) {
    console.error('error: proxy requires --upstream <url>');
    return 3;
  }
  const port = parseInt(args.get('port') ?? '8787', 10);
  const host = args.get('host') ?? '127.0.0.1';
  const prefix = args.get('prefix') ?? '/v1';
  const engine = args.get('engine') ?? '';
  const version = args.get('version') ?? '';
  const server = startProxy({
    upstream,
    host,
    port,
    prefix,
    engineHint: engine || undefined,
    engineVersion: version || undefined,
    onResult: (result, path) => {
      const tag = result.detected
        ? `${fg.yellow('SWALLOW')} pattern=${result.pattern} recovered=${result.recovered} conf=${result.confidence.toFixed(2)}`
        : `${fg.green('clean')}`;
      console.log(`${new Date().toISOString()} ${path} → ${tag}`);
    },
  });
  server.on('error', (e) => {
    console.error(`proxy error: ${e.message}`);
    process.exitCode = 2;
  });
  console.log(`unswallow proxy listening on http://${host}:${port}${prefix} → ${upstream}`);
  console.log(`point your OpenAI-compatible client at http://${host}:${port}${prefix}`);
  console.log('scoped to the reasoning-channel swallow bug class only; everything else passes through untouched.');
  return 0;
}

function cmdMatrix(args: Map<string, string>): number {
  const json = args.has('json');
  const engineFilter = args.get('engine') ?? '';
  const file = getMatrixFile();
  const entries = file.entries.filter(
    (e) => !engineFilter || e.engine === engineFilter || e.harness === engineFilter
  );
  if (json) {
    console.log(JSON.stringify({ matrixVersion: file.matrixVersion, updated: file.updated, entries }, null, 2));
    return 0;
  }
  console.log(`unswallow engine matrix — v${file.matrixVersion} (updated ${file.updated})`);
  console.log('every row is sourced; update via PR against packages/matrix/data/engine-matrix.json or `npm run matrix:update`.');
  console.log();
  console.log(
    table([
      ['engine / harness', 'version range', 'pattern', 'behavior', 'verified', 'source'],
      ...entries.map((e) => [
        e.engine ?? e.harness ?? '—',
        e.versionRange,
        e.pattern,
        e.behavior,
        e.verified ? 'yes' : 'no',
        e.source.replace('https://github.com/', ''),
      ]),
    ])
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(usage());
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
        args.set(key, rest[i + 1]);
        i++;
      } else {
        args.set(key, '');
      }
    }
  }
  switch (cmd) {
    case 'check':
      return await cmdCheck(args);
    case 'matrix':
      return cmdMatrix(args);
    case 'proxy':
      return cmdProxy(args);
    default:
      console.error(`error: unknown command "${cmd}"`);
      console.error(usage());
      return 3;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
);