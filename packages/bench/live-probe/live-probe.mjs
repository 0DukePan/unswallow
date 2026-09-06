/**
 * Live-reproduction harness (TypeScript).
 *
 * Runs every case in packages/bench/live-probe/cases/*.json through
 * unswallow:
 *
 *   - synthetic cases: the recorded rawResponse is fed straight through
 *     checkAndRescue / checkAndRescueStream — no engine needed;
 *   - live cases: the case's prompt is sent to the configured
 *     OpenAI-compatible endpoint and the RAW provider response is captured
 *     first, then run through unswallow.
 *
 * Usage:
 *   node packages/bench/live-probe/live-probe.mjs --out out.json
 *   node packages/bench/live-probe/live-probe.mjs --endpoint http://localhost:8080/v1 \
 *       --model Qwen/Qwen3-4B --engine llama.cpp --version bXXXX --api-key none \
 *       --out out.json
 *
 * Exit 0 when every runnable case passed its expectation; 1 on behavioral
 * failures; 2 on usage/IO errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAndRescue, checkAndRescueStream } from 'unswallow';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(HERE, 'cases');

// Optional defaults file (gitignored): { "endpoint": …, "model": …, "engine": …, "version": …, "apiKey": … }
let DEFAULTS = {};
try {
  DEFAULTS = JSON.parse(fs.readFileSync(path.join(HERE, '.live-probe.env.json'), 'utf8'));
} catch { /* no defaults file — fine */ }

function parseArgs(argv) {
  const out = {
    cases: [], endpoint: DEFAULTS.endpoint ?? null, model: DEFAULTS.model ?? null,
    engine: DEFAULTS.engine ?? null, version: DEFAULTS.version ?? null,
    apiKey: DEFAULTS.apiKey ?? null, outPath: null, failFast: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    switch (a) {
      case '--case': out.cases.push(val()); break;
      case '--endpoint': out.endpoint = val(); break;
      case '--model': out.model = val(); break;
      case '--engine': out.engine = val(); break;
      case '--version': out.version = val(); break;
      case '--api-key': out.apiKey = val(); break;
      case '--out': out.outPath = val(); break;
      case '--fail-fast': out.failFast = true; break;
      case '--help': case '-h':
        console.log(fs.readFileSync(new URL('./live-probe.mjs', import.meta.url), 'utf8').split('Usage:')[1]?.split('\n *\n')[0] ? 'see header' : 'see header');
        return null;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function loadCases(args) {
  const files = args.cases.length > 0
    ? args.cases.map((c) => path.resolve(c))
    : fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(CASES_DIR, f)).sort();
  const cases = [];
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    const p = doc.probe ?? doc; // tolerate both bare case and wrapped forms
    if (!p || !p.id) throw new Error(`case file ${f} has no probe.id`);
    p._file = path.basename(f);
    cases.push(p);
  }
  return cases;
}

// ---- minimal OpenAI-compatible client (no SDK dependency) ----

// Accept both a full endpoint (…/v1/chat/completions) and a base URL
// (…/v1) — the docs and README use the base form.
function chatUrl(endpoint) {
  return /\/chat\/completions$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/$/, '')}/chat/completions`;
}

async function postJson(endpoint, apiKey, body) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey && apiKey !== 'none') headers.authorization = `Bearer ${apiKey}`;
  const t0 = performance.now();
  const res = await fetch(chatUrl(endpoint), { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  const latencyMs = performance.now() - t0;
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* raw text kept */ }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  return { json, text, latencyMs };
}

async function postStream(endpoint, apiKey, body) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (apiKey && apiKey !== 'none') headers.authorization = `Bearer ${apiKey}`;
  const t0 = performance.now();
  const res = await fetch(chatUrl(endpoint), { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { chunks.push(JSON.parse(payload)); } catch { /* ignore keep-alive */ }
    }
  }
  return { chunks, latencyMs: performance.now() - t0 };
}

function buildRequest(probe, args, stream) {
  const req = { ...(probe.request ?? {}) };
  req.messages = req.messages ?? [{ role: 'user', content: 'Hello.' }];
  req.stream = stream;
  // Only set model when explicitly provided: llama.cpp single-model servers
  // reject a model id they do not recognize, and honor an omitted model.
  const model = args.model ?? probe.model;
  if (model) req.model = model;
  else delete req.model;
  delete req._file;
  return req;
}

function expectedOf(probe) {
  const e = probe.expect ?? {};
  return {
    detected: e.detected ?? false,
    pattern: e.pattern ?? null,
    recovered: e.recovered ?? false,
  };
}

function summarize(result) {
  return {
    detected: result.detected,
    pattern: result.pattern,
    toolCalls: (result.toolCalls ?? []).map((tc) => ({ name: tc.name, arguments: tc.arguments })),
    recovered: result.recovered,
    confidence: result.confidence,
    source: result.source,
    engineHint: result.engineHint,
    matrixMatch: result.matrixMatch
      ? { engine: result.matrixMatch.engine, versionRange: result.matrixMatch.versionRange, pattern: result.matrixMatch.pattern, behavior: result.matrixMatch.behavior, verified: result.matrixMatch.verified }
      : null,
    warnings: result.warnings ?? [],
  };
}

async function runCase(probe, args, ctx) {
  const record = {
    caseId: probe.id,
    file: probe._file,
    mode: probe.mode ?? (probe.rawResponse ? 'synthetic' : 'live'),
    engine: probe.engine ?? args.engine ?? null,
    engineVersion: probe.version ?? args.version ?? null,
    model: probe.model ?? args.model ?? null,
    pattern: probe.pattern ?? null,
    stream: probe.stream ?? false,
    expect: expectedOf(probe),
    provider: { endpoint: args.endpoint, engine: probe.engine ?? args.engine ?? null, engineVersion: probe.version ?? args.version ?? null, model: probe.model ?? args.model ?? null },
    detected: null,
    recovery: null,
    errors: [],
    rawResponseCaptured: false,
    unswallow: null,
    latencyMs: null,
    createdAt: new Date().toISOString(),
  };

  try {
    let response;
    let streamChunks = null;
    if (probe.rawResponse) {
      // Synthetic: recorded raw provider response (captured before any unswallow processing).
      response = JSON.parse(JSON.stringify(probe.rawResponse));
      record.rawResponseCaptured = true;
    } else if (probe.chunks) {
      // Synthetic streaming: replay recorded raw chunks through the accumulator.
      const { createStreamAccumulator } = await import('unswallow');
      streamChunks = JSON.parse(JSON.stringify(probe.chunks));
      const rawAcc = createStreamAccumulator();
      for (const c of streamChunks) rawAcc.push(c);
      response = rawAcc.end();
      record.rawResponseCaptured = true;
    } else {
      if (!args.endpoint) throw new Error(`case ${probe.id} is live but no --endpoint given`);
      const request = buildRequest(probe, args, probe.stream);
      record.request = request;
      if (probe.stream) {
        const s = await postStream(args.endpoint, args.apiKey, request);
        streamChunks = s.chunks;
        // Reassemble the raw response exactly as the accumulator would see it.
        const acc = await checkAndRescueStream(streamChunks, { engineHint: args.engine ?? probe.engine, engineVersion: args.version ?? probe.version });
        response = acc.recoveredResponse ?? null; // raw assembled response
        // checkAndRescueStream returns the recovered form; for raw capture we
        // need the assembled-but-unprocessed response — reconstruct it.
        const { createStreamAccumulator } = await import('unswallow');
        const rawAcc = createStreamAccumulator();
        for (const c of streamChunks) rawAcc.push(c);
        response = rawAcc.end();
        record.rawResponseCaptured = true;
      } else {
        const r = await postJson(args.endpoint, args.apiKey, request);
        response = r.json;
        record.rawResponseCaptured = true;
        record.latencyMs = r.latencyMs;
      }
    }

    const checkOpts = {
      engineHint: args.engine ?? probe.engine,
      engineVersion: args.version ?? probe.version,
    };
    const result = probe.stream
      ? await checkAndRescueStream(streamChunks ?? [], checkOpts)
      : checkAndRescue(response, checkOpts);

    record.rawResponse = response;
    record.unswallow = summarize(result);
    record.detected = result.detected;
    record.recovery = {
      recovered: result.recovered,
      toolCalls: (result.toolCalls ?? []).map((tc) => tc.name),
      confidence: result.confidence,
      recoveredResponse: result.recoveredResponse ?? null,
    };
    if (result.recoveredResponse) {
      record.recovered = {
        finishReason: result.recoveredResponse.choices?.[0]?.finish_reason ?? null,
        toolCalls: (result.recoveredResponse.choices?.[0]?.message?.tool_calls ?? []).map((tc) => ({
          name: tc.function?.name ?? null,
          arguments: tc.function?.arguments ?? null,
        })),
      };
    }

    // Assertion against the recorded expectation.
    const exp = record.expect;
    const issues = [];
    if (result.detected !== exp.detected) issues.push(`detected: got ${result.detected}, expected ${exp.detected}`);
    if ((result.pattern ?? null) !== exp.pattern) issues.push(`pattern: got ${result.pattern}, expected ${exp.pattern}`);
    if (result.recovered !== exp.recovered) issues.push(`recovered: got ${result.recovered}, expected ${exp.recovered}`);
    if (exp.recovered && !(result.recoveredResponse && (result.recoveredResponse.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0)) {
      issues.push('expected a recovered response with tool_calls populated');
    }
    record.passed = issues.length === 0;
    record.issues = issues;
    ctx.passed += record.passed ? 1 : 0;
    ctx.total += 1;
    return record;
  } catch (err) {
    record.errors = [err.message];
    record.passed = false;
    ctx.total += 1;
    return record;
  }
}

function renderHuman(records, args) {
  const lines = [];
  lines.push('unswallow live-probe');
  lines.push(`  endpoint: ${args.endpoint ?? '(synthetic only)'}`);
  lines.push('');
  for (const r of records) {
    const status = r.passed ? 'PASS' : 'FAIL';
    lines.push(`[${status}] ${r.caseId}  (${r.mode}, ${r.stream ? 'streaming' : 'non-streaming'}, engine=${r.engine ?? '-'} ${r.engineVersion ?? ''}, model=${r.model ?? '-'})`);
    for (const e of r.errors) lines.push(`    error: ${e}`);
    if (r.unswallow) {
      const u = r.unswallow;
      const names = (u.toolCalls ?? []).map((tc) => tc.name).join(', ') || '-';
      lines.push(`    unswallow: detected=${u.detected} pattern=${u.pattern} recovered=${u.recovered} confidence=${u.confidence} calls=[${names}] source=${u.source}`);
      if (u.matrixMatch) lines.push(`    matrix: ${u.matrixMatch.engine} ${u.matrixMatch.versionRange} ${u.matrixMatch.pattern} → ${u.matrixMatch.behavior} (verified: ${u.matrixMatch.verified})`);
      if (r.latencyMs != null) lines.push(`    provider latency: ${r.latencyMs.toFixed(1)} ms`);
    }
    for (const i of r.issues ?? []) lines.push(`    expected: ${i}`);
    lines.push('');
  }
  lines.push(`${records.filter((r) => r.passed).length}/${records.length} cases passed their expectation.`);
  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
  if (!args) process.exit(0);

  let cases;
  try {
    cases = loadCases(args);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }

  const ctx = { passed: 0, total: 0 };
  const records = [];
  for (const probe of cases) {
    const record = await runCase(probe, args, ctx);
    records.push(record);
    if (args.failFast && !record.passed && record.errors.length === 0) break;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    harness: { language: 'typescript', version: '0.1.3' },
    provider: { endpoint: args.endpoint, engine: args.engine, engineVersion: args.version, model: args.model },
    summary: { passed: records.filter((r) => r.passed).length, total: records.length },
    records,
  };
  if (args.outPath) fs.writeFileSync(path.resolve(args.outPath), JSON.stringify(report, null, 2));

  const human = renderHuman(records, args);
  console.log(human);
  if (args.outPath) console.log(`report written to ${path.resolve(args.outPath)}`);

  process.exit(records.every((r) => r.passed) ? 0 : 1);
}

main().catch((err) => {
  console.error(`fatal: ${err.stack ?? err.message}`);
  process.exit(2);
});
