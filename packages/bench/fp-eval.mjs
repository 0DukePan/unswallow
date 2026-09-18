/**
 * False-positive / false-negative / safety evaluation over the pinned fixture corpus.
 *
 * Three levels are kept strictly separate (see docs/false-positives.md):
 *  - ground truth  — the fixture's `groundTruth.classification` / `recoverable`
 *    labels: what the case really is and whether exposing it as executable would
 *    be faithful to the model's intent.
 *  - detector output — `detected` + `confidence`: evidence of a misplaced call.
 *  - recovery — `recovered` + `recoveredCalls`: the gate-passing calls that the
 *    caller is invited to execute.
 *
 * Metrics:
 *  - detection recall        — genuine swallows detected ÷ genuine fixtures.
 *  - detection FP rate       — non-executable cases flagged as candidates ÷
 *    non-executable fixtures. Annoying, low-stakes on its own, reported per
 *    category (quoted/rehearsal candidates legitimately land here).
 *  - unsafe recovery rate    — non-executable cases actually recovered ÷
 *    non-executable fixtures. THE dangerous failure mode; the CI gate fails on
 *    any nonzero value.
 *  - recovery precision      — recovered calls on intended fixtures ÷ all
 *    recovered calls.
 *  - reconstruction          — recovered calls deep-equal `expectedCalls` where
 *    the fixture declares them.
 *
 * The pinned corpus is adversarial and small: these are regression counts over
 * documented examples, NOT population estimates.
 *
 * Run from the repo root:
 *     node packages/bench/fp-eval.mjs
 *     node packages/bench/fp-eval.mjs --check   # CI: exit nonzero on regression
 *
 * Written by the eval into packages/bench/results/fp-results.{json,md}.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../unswallow/dist/src/index.js');
const { checkAndRescue } = core;

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const RESULTS_DIR = path.join(import.meta.dirname, 'results');
const RESULTS_JSON = path.join(RESULTS_DIR, 'fp-results.json');
const RESULTS_MD = path.join(RESULTS_DIR, 'fp-results.md');
const isCheck = process.argv.includes('--check');

function loadFixtures() {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')));
}

function groundTruthOf(fixture) {
  const gt = fixture.groundTruth ?? {};
  const recoverable =
    typeof gt.recoverable === 'boolean' ? gt.recoverable : (fixture.expect?.detected ?? false) !== false;
  return { classification: gt.classification ?? null, recoverable };
}

function runFixture(fixture) {
  const opts = { engineHint: fixture.engine, engineVersion: fixture.version };
  if (Array.isArray(fixture.toolSchemas)) opts.toolSchemas = fixture.toolSchemas;
  if (fixture.stream) {
    throw new Error(`fp-eval does not support streaming fixtures: ${fixture.id}`);
  }
  return checkAndRescue(fixture.response, opts);
}

/** Seeded negative corpus: discussion-only reasoning that must never fire. */
function syntheticNegatives() {
  const rng = mulberry32(0x66702d65);
  const openers = [
    '< thinking>\nI could call get_weather',
    '< thinking>\nShould I call search? Maybe',
    '< thinking>\nThe user might expect a tool call here but',
  ];
  const middles = [
    ' but the question does not actually require one.',
    ', yet no tool result is needed for this answer.',
    '. I will answer directly instead.',
    '; there is nothing to look up.',
  ];
  const tails = [
    ' I will respond with what I know.\n< response>\n',
    ' No tool call is warranted.\n< response>\n',
    ' Let me just answer.\n< response>\n',
  ];
  const out = [];
  for (let i = 0; i < 200; i++) {
    const a = openers[Math.floor(rng() * openers.length)];
    const b = middles[Math.floor(rng() * middles.length)];
    const c = tails[Math.floor(rng() * tails.length)];
    const text = a + b + c;
    out.push({
      id: `synthetic-negative-${i}`,
      text,
      detected: checkAndRescue(
        {
          id: `synneg-${i}`,
          object: 'chat.completion',
          model: 'synthetic',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '', reasoning: text, tool_calls: [] },
            },
          ],
        },
        { engineHint: 'vllm', engineVersion: '0.19.0' }
      ).detected,
    });
  }
  return out;
}

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

function matrixMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, '..', '..', 'matrix', 'data', 'engine-matrix.json'), 'utf8'));
    return {
      matrixVersion: raw.matrixVersion ?? null,
      updated: raw.updated ?? null,
      engines: [...new Set((raw.entries ?? []).map((e) => e.engine).filter(Boolean))].sort(),
      entries: Array.isArray(raw.entries) ? raw.entries.length : 0,
    };
  } catch {
    return { matrixVersion: null, updated: null, engines: [], entries: 0 };
  }
}

function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function main() {
  const fixtures = loadFixtures();
  const meta = matrixMeta();
  const rows = [];
  let falseNegatives = 0;
  let unsafeRecoveries = 0;
  let detectionFps = 0;
  let genuine = 0;
  let genuineDetected = 0;
  let nonExecutable = 0;
  let nonExecutableCandidateDetected = 0;
  let intendedRecoveredCalls = 0;
  let unintendedRecoveredCalls = 0;
  let reconstructionChecked = 0;
  let reconstructionOk = 0;
  const categoryStats = new Map();

  for (const fixture of fixtures) {
    if (fixture.stream) continue;
    const gt = groundTruthOf(fixture);
    const result = runFixture(fixture);
    const recoveredCallCount = result.recovered ? (result.recoveredCalls?.length ?? 0) : 0;
    const isGenuine = gt.classification === 'swallowed_tool_call';
    const isFalseNegative = gt.recoverable && !result.detected;
    const isUnsafeRecovery = !gt.recoverable && result.recovered;
    // Pattern C field-leak detections are a separate detection class, not a
    // tool-call candidate flag.
    const isDetectionFp = !gt.recoverable && result.detected && result.pattern !== 'C';

    if (isGenuine) {
      genuine++;
      if (result.detected) genuineDetected++;
    }
    if (!gt.recoverable) {
      nonExecutable++;
      if (result.detected && result.pattern !== 'C') nonExecutableCandidateDetected++;
    }
    if (isFalseNegative) falseNegatives++;
    if (isUnsafeRecovery) unsafeRecoveries++;
    if (isDetectionFp) detectionFps++;
    if (gt.recoverable) intendedRecoveredCalls += recoveredCallCount;
    else unintendedRecoveredCalls += recoveredCallCount;

    let reconstruction = null;
    if (Array.isArray(fixture.groundTruth?.expectedCalls) && result.recovered) {
      reconstructionChecked++;
      const actual = (result.recoveredCalls ?? []).map((c) => ({ name: c.name, arguments: c.arguments }));
      try {
        assert.deepStrictEqual(actual, fixture.groundTruth.expectedCalls);
        reconstruction = 'ok';
        reconstructionOk++;
      } catch {
        reconstruction = 'FAIL';
      }
    }

    const key = gt.classification ?? '(none)';
    const stat = categoryStats.get(key) ?? { classification: key, fixtures: 0, detected: 0, recovered: 0, recoverable: 0 };
    stat.fixtures++;
    if (result.detected) stat.detected++;
    if (result.recovered) stat.recovered++;
    if (gt.recoverable) stat.recoverable++;
    categoryStats.set(key, stat);

    rows.push({
      id: fixture.id,
      classification: gt.classification,
      recoverable: gt.recoverable,
      detected: result.detected,
      recovered: result.recovered,
      recoveredCallCount,
      category: result.category,
      falseNegative: isFalseNegative,
      detectionFalsePositive: isDetectionFp,
      unsafeRecovery: isUnsafeRecovery,
      reconstruction,
      note: gt.recoverable ? fixture.source : fixture.groundTruth?.reason ?? fixture.description,
    });
  }

  const synthetic = syntheticNegatives();
  const syntheticFp = synthetic.filter((s) => s.detected).length;

  const totalRecoveredCalls = intendedRecoveredCalls + unintendedRecoveredCalls;
  const summary = {
    corpus: {
      pinnedFixtures: rows.length,
      genuineSwallows: genuine,
      nonExecutableCases: nonExecutable,
      syntheticNegatives: synthetic.length,
    },
    results: {
      falseNegatives,
      detectionFalsePositives: detectionFps,
      unsafeRecoveries,
      syntheticFalsePositives: syntheticFp,
      metrics: {
        detectionRecall: genuine > 0 ? genuineDetected / genuine : null,
        detectionFalsePositiveRate: nonExecutable > 0 ? nonExecutableCandidateDetected / nonExecutable : null,
        unsafeRecoveryRate: nonExecutable > 0 ? unsafeRecoveries / nonExecutable : null,
        recoveryPrecision: totalRecoveredCalls > 0 ? intendedRecoveredCalls / totalRecoveredCalls : null,
        reconstructionCorrectness: reconstructionChecked > 0 ? reconstructionOk / reconstructionChecked : null,
      },
      recoveredCalls: {
        intended: intendedRecoveredCalls,
        unintended: unintendedRecoveredCalls,
      },
      engineMatrix: meta,
    },
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify({ summary, rows, synthetic }, null, 2) + '\n');

  const categories = [...categoryStats.values()].sort((a, b) => a.classification.localeCompare(b.classification));
  const md = [
    '# unswallow — false-positive & safety evaluation',
    '',
    `generated ${summary.generatedAt}`,
    '',
    'Methodology and full definitions: [docs/false-positives.md](../../docs/false-positives.md).',
    '',
    `Evaluation engine matrix: v${meta.matrixVersion ?? '?'} (updated ${meta.updated ?? '?'}) — ${meta.engines.join(', ') || 'none'}, ${meta.entries} rows.`,
    '',
    `The pinned corpus is adversarial and small — these are regression counts over documented examples, **not** population estimates.`,
    '',
    '## Safety headline',
    '',
    '| metric | value |',
    '| --- | --- |',
    `| detection recall (genuine swallows found) | ${pct(summary.results.metrics.detectionRecall)} (${genuineDetected}/${genuine}) |`,
    `| **unsafe recovery rate** (non-executable recovered) | ${pct(summary.results.metrics.unsafeRecoveryRate)} (${unsafeRecoveries}/${nonExecutable}) |`,
    `| recovery precision (intended ÷ all recovered calls) | ${pct(summary.results.metrics.recoveryPrecision)} (${intendedRecoveredCalls}/${totalRecoveredCalls}) |`,
    `| detection false-positive rate (non-executable flagged) | ${pct(summary.results.metrics.detectionFalsePositiveRate)} (${nonExecutableCandidateDetected}/${nonExecutable}) |`,
    `| reconstruction correctness (recovered == expectedCalls) | ${pct(summary.results.metrics.reconstructionCorrectness)} (${reconstructionOk}/${reconstructionChecked}) |`,
    `| false negatives (genuine swallows missed) | ${falseNegatives} |`,
    `| false positives on seeded synthetic negatives | ${syntheticFp}/${synthetic.length} |`,
    '',
    'Detection false positives are a candidate-classification event (annoying, low-stakes);',
    'unsafe recovery is the dangerous failure mode and is gated separately — the CI check fails on any nonzero unsafe recovery.',
    '',
    '## Per-category outcomes',
    '',
    '| classification | fixtures | detected | recovered | recoverable |',
    '| --- | --- | --- | --- | --- |',
    ...categories.map(
      (c) => `| ${c.classification} | ${c.fixtures} | ${c.detected} | ${c.recovered} | ${c.recoverable} |`
    ),
    '',
    '## Pinned corpus',
    '',
    '| fixture | classification | recoverable | detected | category | recovered | calls | verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) =>
      [
        r.id,
        r.classification ?? '—',
        r.recoverable ? 'yes' : 'no',
        r.detected ? 'yes' : 'no',
        r.category ?? '—',
        r.recovered ? 'yes' : 'no',
        r.recovered ? String(r.recoveredCallCount) : '—',
        r.unsafeRecovery
          ? '**UNSAFE RECOVERY**'
          : r.falseNegative
            ? 'FALSE NEGATIVE'
            : r.reconstruction === 'FAIL'
              ? 'RECONSTRUCTION FAIL'
              : 'ok',
      ].join(' | ')
    ),
    '',
    '## Seeded synthetic negatives',
    '',
    `200 seeded discussion-only reasoning samples (mulberry32 seed 0x66702d65) — a model thinking *about* calling a tool, never invoking one.`,
    '',
    `False positives on the synthetic negatives: ${syntheticFp}/${synthetic.length}`,
    '',
  ].join('\n');
  fs.writeFileSync(RESULTS_MD, md);

  console.log(`fp-eval: ${rows.length} pinned fixtures (${genuine} genuine, ${nonExecutable} non-executable), ${synthetic.length} synthetic negatives`);
  console.log(`  detection recall: ${pct(summary.results.metrics.detectionRecall)}`);
  console.log(`  unsafe recoveries: ${unsafeRecoveries} (rate ${pct(summary.results.metrics.unsafeRecoveryRate)})`);
  console.log(`  recovery precision: ${pct(summary.results.metrics.recoveryPrecision)}`);
  console.log(`  detection false positives: ${detectionFps} (rate ${pct(summary.results.metrics.detectionFalsePositiveRate)})`);
  console.log(`  reconstruction: ${reconstructionOk}/${reconstructionChecked} ok`);
  console.log(`  false negatives: ${falseNegatives}`);
  if (isCheck) {
    if (unsafeRecoveries > 0 || falseNegatives > 0 || syntheticFp > 0) {
      console.error('fp-eval FAILED: unsafe recoveries and/or false negatives on the pinned corpus');
      for (const r of rows) {
        if (r.unsafeRecovery) console.error(`  UNSAFE RECOVERY: ${r.id}`);
        if (r.falseNegative) console.error(`  FALSE NEGATIVE: ${r.id}`);
      }
      process.exit(1);
    }
    console.log('fp-eval: no unsafe recoveries, no false negatives on the pinned corpus');
  }
}

main();
