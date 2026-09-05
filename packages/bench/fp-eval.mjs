/**
 * False-positive / false-negative evaluation over the pinned fixture corpus.
 *
 * A response is a *false positive* when unswallow reports a detection (or
 * recovers a tool call) on an input where no tool call was actually invoked.
 * A response is a *false negative* when a real swallow is missed.
 *
 * Definitions (documented in docs/false-positives.md):
 *  - Positive example  = a raw provider response that genuinely contains a
 *    tool call the model intended to invoke (the upstream servers failed to
 *    surface it in `tool_calls[]`). Fixture label: `expect.detected === true`.
 *  - Negative example  = a raw provider response with no intended tool call,
 *    even when it discusses tool-call syntax. Fixture label:
 *    `expect.detected === false` (`pattern: null` fixtures).
 *  - False positive   = negative example that unswallow reports as detected
 *    (or worse: recovers).
 *  - False negative   = positive example that unswallow fails to detect.
 *
 * Because the pinned corpus is small and adversarial (not a random sample of
 * provider traffic), the numbers below are *not* population estimates. They
 * are regression counts over the pinned corpus plus a seeded synthetic
 * negative set: the honest claim is "0 false positives on the documented
 * negative corpus", never "0% false-positive rate in production".
 *
 * Run from the repo root:
 *     node packages/bench/fp-eval.mjs
 *     node packages/bench/fp-eval.mjs --check   # CI: exit nonzero on regression
 *
 * Written by the eval into packages/bench/results/fp-results.{json,md}.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

function labelOf(fixture) {
  const expect = fixture.expect ?? {};
  return expect.detected === false ? 'negative' : 'positive';
}

function runFixture(fixture) {
  const opts = { engineHint: fixture.engine, engineVersion: fixture.version };
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

const WORDS = [
  'the', 'user', 'asked', 'about', 'weather', 'tokyo', 'need', 'call', 'tool',
  'reasoning', 'carefully', 'check', 'arguments', 'city', 'answer', 'would',
  'maybe', 'perhaps', 'use', 'get_weather', 'function', 'could', 'then', 'final',
  'consider', 'likely', 'summarize', 'directly', 'instead', 'schema', 'emit',
];

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

function sentence(rng) {
  const n = 8 + Math.floor(rng() * 16);
  const words = [];
  for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(rng() * WORDS.length)]);
  return words.join(' ') + '.';
}

function main() {
  const fixtures = loadFixtures();
  const rows = [];
  let fp = 0;
  let fn = 0;
  let positives = 0;
  let negatives = 0;

  for (const fixture of fixtures) {
    if (fixture.stream) continue;
    const label = labelOf(fixture);
    const result = runFixture(fixture);
    const isFp = label === 'negative' && result.detected;
    const isFn = label === 'positive' && !result.detected;
    if (isFp) fp++;
    if (isFn) fn++;
    if (label === 'positive') positives++;
    else negatives++;
    rows.push({
      id: fixture.id,
      label,
      expectedDetected: label === 'positive',
      detected: result.detected,
      recovered: result.recovered,
      pattern: result.pattern,
      falsePositive: isFp,
      falseNegative: isFn,
      note: label === 'positive' ? fixture.source : fixture.description,
    });
  }

  const synthetic = syntheticNegatives();
  const syntheticFp = synthetic.filter((s) => s.detected).length;

  const accuracy =
    (positives + negatives) > 0
      ? (positives + negatives - fp - fn) / (positives + negatives)
      : null;
  const summary = {
    corpus: {
      pinnedPositives: positives,
      pinnedNegatives: negatives,
      syntheticNegatives: synthetic.length,
      total: positives + negatives + synthetic.length,
    },
    results: {
      falsePositives: fp,
      falseNegatives: fn,
      syntheticFalsePositives: syntheticFp,
      detectionAccuracy: accuracy,
    },
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify({ summary, rows, synthetic }, null, 2) + '\n');

  const md = [
    '# unswallow — false-positive evaluation',
    '',
    `generated ${summary.generatedAt}`,
    '',
    'Methodology and full definitions: [docs/false-positives.md](../../docs/false-positives.md).',
    '',
    `The pinned corpus is adversarial and small — these are regression counts over documented examples, **not** population estimates.`,
    '',
    '## Results',
    '',
    `| metric | count |`,
    `| --- | --- |`,
    `| pinned positive examples (real swallow shapes) | ${positives} |`,
    `| pinned negative examples (discussion / near-miss) | ${negatives} |`,
    `| seeded synthetic negatives | ${synthetic.length} |`,
    `| false positives (pinned negatives detected) | ${fp} |`,
    `| false negatives (pinned positives missed) | ${fn} |`,
    `| false positives (synthetic negatives) | ${syntheticFp} |`,
    `| detection accuracy on the pinned corpus | ${accuracy === null ? 'n/a' : (accuracy * 100).toFixed(1) + '%'} |`,
    '',
    '## Pinned corpus',
    '',
    '| fixture | label | expected | detected | recovered | verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) =>
      `| ${r.id} | ${r.label} | ${r.expectedDetected ? 'detect' : 'none'} | ${r.detected ? 'yes' : 'no'} | ${r.recovered ? 'yes' : 'no'} | ${r.falsePositive ? 'FALSE POSITIVE' : r.falseNegative ? 'FALSE NEGATIVE' : 'ok'} |`
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

  console.log(`fp-eval: ${positives} positives, ${negatives} pinned negatives, ${synthetic.length} synthetic negatives`);
  console.log(`  false positives: ${fp} pinned, ${syntheticFp} synthetic`);
  console.log(`  false negatives: ${fn}`);
  console.log(`  detection accuracy (pinned): ${accuracy === null ? 'n/a' : (accuracy * 100).toFixed(1) + '%'}`);
  if (isCheck) {
    if (fp > 0 || fn > 0 || syntheticFp > 0) {
      console.error('fp-eval FAILED: false positives and/or false negatives on the pinned corpus');
      for (const r of rows) {
        if (r.falsePositive) console.error(`  FALSE POSITIVE: ${r.id}`);
        if (r.falseNegative) console.error(`  FALSE NEGATIVE: ${r.id}`);
      }
      process.exit(1);
    }
    console.log('fp-eval: no false positives, no false negatives on the pinned corpus');
  }
}

main();
