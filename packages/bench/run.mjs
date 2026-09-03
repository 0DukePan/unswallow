import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../unswallow/dist/src/index.js');
const { checkAndRescue, checkAndRescueStream, matchMatrixEntry } = core;
const matrixEntries = require('unswallow-matrix').entries;

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const MANIFEST_PATH = path.join(import.meta.dirname, 'fixtures.sha256');
const RESULTS_DIR = path.join(import.meta.dirname, 'results');
const RESULTS_JSON = path.join(RESULTS_DIR, 'results.json');
const RESULTS_MD = path.join(RESULTS_DIR, 'results.md');

const isCheck = process.argv.includes('--check');
const isUpdatePins = process.argv.includes('--update-pins');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return new Map();
  const map = new Map();
  for (const line of fs.readFileSync(MANIFEST_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

function writeManifest(files) {
  const lines = files
    .map((f) => `${sha256File(f)}  ${path.basename(f)}`)
    .sort()
    .join('\n');
  fs.writeFileSync(MANIFEST_PATH, lines + '\n');
}

const fixtureFiles = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => path.join(FIXTURES_DIR, f));

if (isUpdatePins) {
  writeManifest(fixtureFiles);
  console.log('fixtures.sha256 updated');
}

const manifest = readManifest();
const pinned = fixtureFiles.filter((f) => manifest.has(path.basename(f)));
const unpinned = fixtureFiles.filter((f) => !manifest.has(path.basename(f)));
if (unpinned.length > 0 && !isUpdatePins) {
  console.error(`error: ${unpinned.length} fixture(s) not in fixtures.sha256 manifest:`);
  for (const f of unpinned) console.error(`  ${path.basename(f)}`);
  console.error('run `npm run bench:update` to pin them');
  process.exit(1);
}
const drifted = pinned.filter((f) => manifest.get(path.basename(f)) !== sha256File(f));
if (drifted.length > 0 && !isUpdatePins) {
  console.error('error: fixture hash drift detected (fixture modified after pinning):');
  for (const f of drifted) console.error(`  ${path.basename(f)}`);
  console.error('a pinned fixture must never change silently — run `npm run bench:update` only after review');
  process.exit(1);
}

const results = [];
let passed = 0;
let failed = 0;

for (const file of fixtureFiles) {
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = fixture.id ?? path.basename(file, '.json');
  const expect = fixture.expect ?? {};
  let outcome;
  try {
    const opts = {
      engineHint: fixture.engine || undefined,
      engineVersion: fixture.version || undefined,
    };
    const result = fixture.stream
      ? await checkAndRescueStream(fixture.chunks ?? [], opts)
      : checkAndRescue(fixture.response, opts);
    const checks = [
      ['detected', result.detected, expect.detected],
      ['pattern', result.pattern, expect.pattern ?? null],
      ['recovered', result.recovered, expect.recovered ?? false],
      ['confidence', result.confidence, expect.minConfidence ?? 0, '>='],
    ];
    if (expect.toolCallCount !== undefined) {
      checks.push(['toolCallCount', result.toolCalls?.length ?? 0, expect.toolCallCount]);
    }
    const failures = checks
      .filter(([, actual, wanted, op]) =>
        op === '>=' ? actual < wanted : actual !== wanted
      )
      .map(([name, actual, wanted]) => `${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
    outcome = { ok: failures.length === 0, failures, result };
  } catch (e) {
    outcome = { ok: false, failures: [`runner error: ${e.message}`], result: null };
  }

  if (outcome.ok) passed++;
  else failed++;
  results.push({
    id,
    engine: fixture.engine ?? null,
    version: fixture.version ?? null,
    pattern: fixture.pattern ?? null,
    source: fixture.source ?? null,
    sourced: fixture.sourced ?? false,
    stream: fixture.stream ?? false,
    sha256: sha256File(file),
    expect: {
      detected: expect.detected ?? false,
      pattern: expect.pattern ?? null,
      recovered: expect.recovered ?? false,
      minConfidence: expect.minConfidence ?? 0,
      ...(expect.toolCallCount !== undefined ? { toolCallCount: expect.toolCallCount } : {}),
    },
    actual: outcome.result
      ? {
          detected: outcome.result.detected,
          pattern: outcome.result.pattern,
          recovered: outcome.result.recovered,
          confidence: outcome.result.confidence,
          toolCall: outcome.result.toolCall,
          toolCallCount: outcome.result.toolCalls?.length ?? 0,
        }
      : null,
    failures: outcome.failures,
  });
}

const consistency = [];
for (const r of results) {
  if (!r.engine || !r.version || !r.pattern || r.pattern === 'D') continue;
  const row = matchMatrixEntry(matrixEntries, r.engine, r.version, r.pattern);
  if (!row) {
    consistency.push({
      id: r.id,
      ok: true,
      note: `no matrix row for ${r.engine} ${r.version} pattern ${r.pattern} — novel combination, keep an eye on it`,
    });
    continue;
  }
  const expectsDetection = row.behavior === 'swallow' || row.behavior === 'partial';
  const ok = expectsDetection === r.expect.detected;
  consistency.push({
    id: r.id,
    ok,
    note: `matrix ${row.engine} ${row.versionRange} → ${row.behavior}; fixture expects ${r.expect.detected ? 'detection' : 'no detection'}`,
  });
}
const consistencyFails = consistency.filter((c) => !c.ok);

const summary = {
  runner: 'unswallow bench runner v1',
  fixtures: results.length,
  passed,
  failed,
  manifest: 'fixtures.sha256',
  manifestVerified: true,
  matrixConsistency: {
    checked: consistency.length,
    failed: consistencyFails.length,
  },
  generatedAt: new Date().toISOString(),
};

console.log(`bench: ${passed}/${results.length} fixtures passed`);
for (const r of results) {
  const mark = r.failures.length === 0 ? 'ok ' : 'FAIL';
  console.log(`  ${mark} ${r.id}  ${r.actual ? `pattern=${r.actual.pattern ?? '-'} recovered=${r.actual.recovered} conf=${r.actual.confidence.toFixed(2)}` : ''}`);
  for (const f of r.failures) console.log(`      ${f}`);
}

console.log(`matrix consistency: ${consistency.length - consistencyFails.length}/${consistency.length} fixtures align with matrix rows`);
for (const c of consistency) {
  const mark = c.ok ? 'ok ' : 'FAIL';
  console.log(`  ${mark} ${c.id} — ${c.note}`);
}
if (consistencyFails.length > 0) {
  console.log('matrix↔fixture mismatch: flipping a matrix row to a different behavior requires flipping the fixture expectation');
}

if (isCheck) {
  process.exit(failed === 0 && consistencyFails.length === 0 ? 0 : 1);
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(RESULTS_JSON, JSON.stringify({ ...summary, results, consistency }, null, 2) + '\n');

const md = [
  '| id | engine | version | expected | actual | recovered | confidence | status |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...results.map((r) =>
    [
      r.id,
      r.engine ?? '—',
      r.version ?? '—',
      r.expect.pattern ?? 'none',
      r.actual ? (r.actual.pattern ?? 'none') : 'ERR',
      r.actual ? (r.actual.recovered ? 'yes' : 'no') : '—',
      r.actual ? r.actual.confidence.toFixed(2) : '—',
      r.failures.length === 0 ? 'PASS' : 'FAIL',
    ]
      .map((c) => String(c))
      .join(' | ')
  ),
  '',
  `**${passed}/${results.length} fixtures passing** — fixtures are hash-pinned (see \`fixtures.sha256\`); engine/version hints per fixture; every \`source\` is cited in the fixture file. Matrix↔fixture consistency: ${consistency.length - consistencyFails.length}/${consistency.length}.`,
  '',
].join('\n');
fs.writeFileSync(RESULTS_MD, md);

console.log(`results written to bench/results/ (json + md)`);
process.exit(failed === 0 ? 0 : 1);