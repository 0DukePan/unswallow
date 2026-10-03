#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { checkAndRescue, createStreamAccumulator, getMatrixFile, matchMatrixEntry, normalizeEngine, startProxy, type CheckOptions, type RawProviderResponse, type SwallowCheckResult, type ToolSchema } from '../src/index';
import { demoFixture } from './demo';
import { bar, fg, pad, table } from './format';
import { PROBE_TOOL, probeEndpoint, probeEndpointStream } from './probe';

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const VERSION = readVersion();
const CLI_JSON_SCHEMA_VERSION = '1';

const EXIT_OK = 0;
const EXIT_AFFECTED = 1;
const EXIT_ERROR = 2;
const EXIT_USAGE = 3;
const EXIT_INCONCLUSIVE = 4;

/** Flags that never take a value, so they cannot swallow the next positional argument. */
const BOOLEAN_FLAGS = new Set(['json', 'stream', 'strict-schema', 'request-aware', 'help']);

type ProbeState = 'healthy' | 'affected' | 'inconclusive';

interface ProbePass {
  mode: 'non-streaming' | 'streaming';
  state: ProbeState;
  result: SwallowCheckResult;
  response: RawProviderResponse;
  status: number;
}

function hasParsedToolCalls(response: unknown): boolean {
  const message = (response as { choices?: Array<{ message?: { tool_calls?: unknown } }> } | null | undefined)?.choices?.[0]?.message;
  return Array.isArray(message?.tool_calls) && (message!.tool_calls as unknown[]).length > 0;
}

/** affected: swallow-like signal; healthy: the server returned parsed tool_calls; inconclusive: no tool call was elicited at all. */
function probeState(result: SwallowCheckResult, response: unknown): ProbeState {
  if (result.detected) return 'affected';
  return hasParsedToolCalls(response) ? 'healthy' : 'inconclusive';
}

function overallState(passes: ProbePass[], modes: readonly string[]): ProbeState {
  if (passes.some((p) => p.state === 'affected')) return 'affected';
  const everyModeHealthy = modes.every((m) => passes.some((p) => p.mode === m && p.state === 'healthy'));
  return everyModeHealthy ? 'healthy' : 'inconclusive';
}

function apiKeyFrom(args: Map<string, string>): string | undefined {
  return args.get('api-key') || process.env.UNSWALLOW_API_KEY || process.env.OPENAI_API_KEY || undefined;
}

function probeFailure(error: string, status: number | undefined, json: boolean): number {
  console.error(`probe failed: ${error}`);
  if (json) console.log(JSON.stringify({ probeOk: false, error, status: status ?? null }));
  return EXIT_ERROR;
}

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
    '                 [--timeout <ms>] [--stream] [--samples <n>] [--json]',
    '  unswallow inspect <file> [--schema <tools.json>] [--engine <e>] [--version <v>] [--json]',
    '  unswallow doctor --endpoint <url> --model <m> [--api-key <k>] [--engine <e>] [--version <v>] [--out <file>] [--json]',
    '  unswallow matrix [--engine <e>] [--json]',
    '  unswallow proxy --upstream <url> [--port <p>] [--host <h>] [--prefix <p>]',
    '                  [--engine <e>] [--version <v>] [--mode <recover|observe>]',
    '                  [--intent-gate <block|strict|off>] [--min-confidence <0-1>]',
    '                  [--strict-schema] [--side-effecting <a,b>] [--request-aware]',
    '',
    '  check with no source runs the bundled self-test demo (vLLM #39056 fixture).',
    '  check --endpoint probes a live OpenAI-compatible server for the swallow.',
    '    --stream also probes the streaming path; --samples <n> repeats the probe (max 20).',
    '  proxy --mode observe detects and logs but never rewrites a response.',
    '  check --fixture runs against a captured raw response JSON file.',
    '  proxy runs an OpenAI-compatible passthrough that detects and recovers',
    '  the swallow inline — scoped strictly to this bug class.',
    '',
    'exit codes: 0 = healthy / not affected, 1 = affected, 2 = error, 3 = usage error,',
    '            4 = inconclusive (the probe never elicited a tool call; not a clean bill of health)',
    '',
    'options:',
    '  --engine <vllm|sglang|llama.cpp>   engine hint for matrix-aware confidence',
    '  --version <x.y.z>                  server version for matrix-aware confidence',
    '  --json                             machine-readable output',
    '  --api-key <k>                      or set UNSWALLOW_API_KEY / OPENAI_API_KEY (keeps the key out of shell history)',
  ].join('\n');
}

function renderVerdict(r: SwallowCheckResult, engine: string, version: string, original?: unknown, state?: ProbeState): void {
  const line = '─'.repeat(64);
  if (!r.detected) {
    if (hasParsedToolCalls(original)) {
      console.log(fg.green('✓ NO SWALLOW DETECTED'));
      console.log('  response already carries parsed tool_calls — nothing to do.');
    } else if (state === 'inconclusive') {
      console.log(fg.yellow('? INCONCLUSIVE — the probe did not elicit a tool call'));
      console.log('  the model answered without calling a tool, so this run cannot show whether the server swallows.');
      console.log('  re-run (use --samples), or try a model/prompt that reliably calls tools. This is not a clean bill of health.');
    } else {
      console.log(fg.green('✓ NO SWALLOW DETECTED'));
      console.log('  no tool-call envelope found in any reasoning channel.');
    }
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
    const calls = r.recoveredCalls ?? [];
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
  } else if (r.detected) {
    console.log(`  ${fg.yellow('recovery withheld by the intent gate — see warnings below')}`);
  }
  console.log();
  console.log(`confidence    : ${bar(r.confidence)} ${fg.bold(String(r.confidence.toFixed(2)))}`);
  console.log(`category      : ${r.category ? fg.bold(r.category) : fg.dim('—')}`);
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
      return EXIT_USAGE;
    }
    const timeout = args.has('timeout') ? parseInt(args.get('timeout')!, 10) : 60000;
    const samples = Math.max(1, Math.min(20, parseInt(args.get('samples') ?? '1', 10) || 1));
    const modes = args.has('stream') ? (['non-streaming', 'streaming'] as const) : (['non-streaming'] as const);
    const base = { endpoint, model, apiKey: apiKeyFrom(args), timeoutMs: Number.isFinite(timeout) ? timeout : 60000 };
    // Validate recovered calls against the probe's own tool: a recovery must be get_weather({city}).
    const checkOpts: CheckOptions = {
      engineHint: engine || undefined,
      engineVersion: version || undefined,
      toolSchemas: [PROBE_TOOL as unknown as ToolSchema],
    };
    const passes: ProbePass[] = [];
    for (let i = 0; i < samples; i++) {
      for (const mode of modes) {
        let response: RawProviderResponse;
        let status: number;
        if (mode === 'non-streaming') {
          const p = await probeEndpoint(base);
          if (!p.ok) return probeFailure(p.error, p.status, json);
          response = p.response;
          status = p.status;
        } else {
          const p = await probeEndpointStream(base);
          if (!p.ok) return probeFailure(p.error, p.status, json);
          const acc = createStreamAccumulator();
          for (const chunk of p.chunks) acc.push(chunk);
          response = acc.end();
          status = p.status;
        }
        const result = checkAndRescue(response, checkOpts);
        passes.push({ mode, state: probeState(result, response), result, response, status });
      }
    }
    const overall = overallState(passes, modes);
    const shown = passes.find((p) => p.state === 'affected') ?? passes.find((p) => p.state === overall) ?? passes[0];
    const exit = overall === 'affected' ? EXIT_AFFECTED : overall === 'inconclusive' ? EXIT_INCONCLUSIVE : EXIT_OK;
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: CLI_JSON_SCHEMA_VERSION,
            status: overall,
            passes: passes.map((p) => ({ mode: p.mode, state: p.state, probeStatus: p.status })),
            ...shown.result,
            probeStatus: shown.status,
          },
          null,
          2
        )
      );
      return exit;
    }
    console.log(`unswallow check — probe ${endpoint}/chat/completions (${shown.status})`);
    console.log(`model         : ${model}`);
    console.log(`engine        : ${engine || 'unknown'}${version ? ' ' + version : ''}`);
    if (passes.length > 1 || modes.length > 1) {
      for (const m of modes) {
        const ps = passes.filter((p) => p.mode === m);
        const n = (st: ProbeState) => ps.filter((p) => p.state === st).length;
        console.log(`probes        : ${pad(m, 14)} ${ps.length}× — healthy ${n('healthy')}, affected ${n('affected')}, inconclusive ${n('inconclusive')}`);
      }
    }
    console.log('─'.repeat(64));
    renderVerdict(shown.result, engine, version, shown.response, shown.state);
    return exit;
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
  const failOnDetect = fixture !== undefined; // the bundled demo always detects: keep it exit 0
  if (json) {
    console.log(JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ...result }, null, 2));
    return failOnDetect && result.detected ? EXIT_AFFECTED : EXIT_OK;
  }
  console.log(`unswallow check — reasoning-channel swallow scan`);
  console.log(`source        : ${srcDesc}`);
  console.log(`engine        : ${engineHint || 'unknown'}${engineVersion ? ' ' + engineVersion : ''}`);
  console.log('─'.repeat(64));
  renderVerdict(result, engineHint, engineVersion, source);
  return failOnDetect && result.detected ? EXIT_AFFECTED : EXIT_OK;
}

function readToolSchemas(file: string | undefined): ToolSchema[] | undefined {
  if (!file) return undefined;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (Array.isArray(value)) return value as ToolSchema[];
  if (value && typeof value === 'object' && Array.isArray((value as { tools?: unknown }).tools)) {
    return (value as { tools: ToolSchema[] }).tools;
  }
  throw new Error('schema file must be a JSON array or an object with a tools array');
}

function cmdInspect(args: Map<string, string>, file: string): number {
  try {
    const fixture = readFixtureFile(file);
    if (!fixture) throw new Error('file is not valid response JSON');
    const schemas = readToolSchemas(args.get('schema'));
    const engine = args.get('engine') ?? fixture.engineHint ?? '';
    const version = args.get('version') ?? fixture.engineVersion ?? '';
    const result = checkAndRescue(fixture.response as Parameters<typeof checkAndRescue>[0], {
      engineHint: engine || undefined, engineVersion: version || undefined, toolSchemas: schemas,
    });
    if (args.has('json')) console.log(JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ...result }, null, 2));
    else {
      console.log(`unswallow inspect — ${file}`);
      renderVerdict(result, engine, version, fixture.response);
      if (result.validation) console.log(`validation    : name=${result.validation.nameKnown}, schema=${result.validation.schemaValid}, structural=${result.validation.structurallyValid}`);
    }
    return result.detected ? 1 : 0;
  } catch (e) {
    console.error(`error: cannot inspect file: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

async function cmdDoctor(args: Map<string, string>): Promise<number> {
  const endpoint = args.get('endpoint');
  const model = args.get('model');
  if (!endpoint || !model) {
    console.error('error: doctor requires --endpoint <url> and --model <m>');
    return 3;
  }
  const probe = await probeEndpoint({ endpoint, model, apiKey: apiKeyFrom(args) });
  if (!probe.ok) {
    console.error(`doctor probe failed: ${probe.error}`);
    return 2;
  }
  const engine = args.get('engine') ?? '';
  const version = args.get('version') ?? '';
  const result = checkAndRescue(probe.response, { engineHint: engine || undefined, engineVersion: version || undefined, toolSchemas: [PROBE_TOOL as unknown as ToolSchema] });
  const state = probeState(result, probe.response);
  const out = args.get('out');
  if (out) {
    try {
      fs.writeFileSync(out, JSON.stringify({ engine, version, response: probe.response }, null, 2) + '\n');
    } catch (e) {
      console.error(`error: cannot write raw response: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }
  const matrix = engine && version && result.pattern
    ? matchMatrixEntry(getMatrixFile().entries, normalizeEngine(engine) as never, version, result.pattern)
    : null;
  const status = result.detected ? (result.recovered ? 'recovery-supported' : 'affected') : state === 'healthy' ? 'healthy' : 'inconclusive';
  const report = { schemaVersion: CLI_JSON_SCHEMA_VERSION, status, probeStatus: probe.status, rawResponseFile: out ?? null, result, compatibility: matrix ?? null, recommendation: matrix?.fixHint ?? null };
  if (args.has('json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`unswallow doctor: ${status}`);
    renderVerdict(result, engine, version, probe.response, state);
    if (matrix?.fixHint) console.log(`recommendation : ${matrix.fixHint}`);
    else if (!engine || !version) console.log('compatibility  : pass --engine and --version for matrix guidance');
  }
  return result.detected ? EXIT_AFFECTED : state === 'inconclusive' ? EXIT_INCONCLUSIVE : EXIT_OK;
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
  const mode = args.get('mode') ?? 'recover';
  if (mode !== 'recover' && mode !== 'observe') {
    console.error('error: --mode must be "recover" or "observe"');
    return EXIT_USAGE;
  }
  const gate = args.get('intent-gate');
  if (gate !== undefined && gate !== 'block' && gate !== 'strict' && gate !== 'off') {
    console.error('error: --intent-gate must be "block", "strict" or "off"');
    return EXIT_USAGE;
  }
  const minConfidence = args.has('min-confidence') ? parseFloat(args.get('min-confidence')!) : undefined;
  if (minConfidence !== undefined && !(minConfidence >= 0 && minConfidence <= 1)) {
    console.error('error: --min-confidence must be a number between 0 and 1');
    return EXIT_USAGE;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('error: --port must be an integer between 0 and 65535');
    return EXIT_USAGE;
  }
  const sideEffecting = (args.get('side-effecting') ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  const observeOnly = mode === 'observe';
  const server = startProxy({
    upstream,
    host,
    port,
    prefix,
    engineHint: engine || undefined,
    engineVersion: version || undefined,
    observeOnly,
    requestAware: args.has('request-aware'),
    ...(gate ? { intentGate: gate as 'block' | 'strict' | 'off' } : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    ...(args.has('strict-schema') ? { strictSchema: true } : {}),
    ...(sideEffecting.length > 0 ? { sideEffectingTools: sideEffecting } : {}),
    onResult: (result, path) => {
      const tag = result.detected
        ? `${fg.yellow('SWALLOW')} pattern=${result.pattern} category=${result.category ?? '-'} recovered=${result.recovered}${observeOnly ? ' (observe-only, response not rewritten)' : ''} conf=${result.confidence.toFixed(2)}`
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
  const engineRaw = args.get('engine') ?? '';
  const engineNorm = normalizeEngine(engineRaw);
  const engineFilter = engineNorm !== 'unknown' ? engineNorm : engineRaw;
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
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        args.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        args.set(key, '');
        continue;
      }
      if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
        args.set(key, rest[i + 1]);
        i++;
      } else {
        args.set(key, '');
      }
    } else {
      positional.push(a);
    }
  }
  switch (cmd) {
    case 'check':
      return await cmdCheck(args);
    case 'inspect':
      if (!positional[0]) {
        console.error('error: inspect requires <file>');
        return 3;
      }
      return cmdInspect(args, positional[0]);
    case 'doctor':
      return await cmdDoctor(args);
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