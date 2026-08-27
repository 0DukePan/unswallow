import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_PATH = path.join(ROOT, 'data', 'upstream-status.json');

const TRACKED = [
  { key: 'vllm-39056', url: 'https://api.github.com/repos/vllm-project/vllm/issues/39056', label: 'vLLM pattern A/B' },
  { key: 'sglang-30744', url: 'https://api.github.com/repos/sgl-project/sglang/issues/30744', label: 'SGLang pattern A' },
  { key: 'llamacpp-20837', url: 'https://api.github.com/repos/ggml-org/llama.cpp/issues/20837', label: 'llama.cpp pattern A' },
  { key: 'pi-952', url: 'https://api.github.com/repos/earendil-works/pi/issues/952', label: 'pi pattern B' },
  { key: 'openwebui-23339', url: 'https://api.github.com/repos/open-webui/open-webui/issues/23339', label: 'history drift (pattern D)' },
];

async function fetchIssue(url, token) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'unswallow-matrix-watch',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const issue = await res.json();
  return {
    key: issue.number,
    title: issue.title,
    state: issue.state,
    comments: issue.comments,
    updatedAt: issue.updated_at,
    labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
  };
}

const token = process.env.GITHUB_TOKEN || '';
const dry = process.argv.includes('--dry');

const status = {};
for (const t of TRACKED) {
  try {
    status[t.key] = { label: t.label, issueUrl: t.url.replace('api.github.com/repos/', 'github.com/'), ...(await fetchIssue(t.url, token)) };
  } catch (e) {
    status[t.key] = { label: t.label, issueUrl: t.url.replace('api.github.com/repos/', 'github.com/'), error: e.message };
  }
}

const previous = fs.existsSync(STATUS_PATH) ? JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) : {};
const changed = [];
for (const [k, v] of Object.entries(status)) {
  const prev = previous[k] ?? {};
  for (const field of ['state', 'comments', 'title']) {
    if (prev[field] !== undefined && prev[field] !== v[field]) {
      changed.push(`[${k}] ${field}: ${prev[field]} -> ${v[field]}`);
    }
  }
  if (!prev.state && v.state) changed.push(`[${k}] newly tracked: ${v.state}`);
}

console.log('upstream issue status:');
for (const [k, v] of Object.entries(status)) {
  if (v.error) {
    console.log(`  ${k}: ERROR ${v.error}`);
  } else {
    console.log(`  ${k}: ${v.state} (${v.comments} comments) — ${v.title}`);
  }
}

if (changed.length > 0) {
  console.log('\nchanges vs last snapshot:');
  for (const c of changed) console.log(`  ${c}`);
} else {
  console.log('\nno changes vs last snapshot');
}

const closedUnresolved = Object.entries(status).filter(([, v]) => v.state === 'closed');
for (const [k, v] of closedUnresolved) {
  console.log(`\nnote: ${k} (${v.label}) is CLOSED — review whether data/engine-matrix.json rows sourced to it need updating`);
}

const MATRIX_PATH = path.join(ROOT, 'data', 'engine-matrix.json');
const FIXTURES_DIR = path.join(ROOT, '..', 'bench', 'fixtures');

function parseVersion(v) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v));
  if (!m) return null;
  return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, m[3] ? parseInt(m[3], 10) : 0];
}

function inRange(version, range) {
  const v = parseVersion(version);
  if (!v) {
    const m = /(\d+(?:\.\d+){0,2})/.exec(String(version));
    if (m) return inRange(m[1], range);
    return range === '*';
  }
  if (range === '*') return true;
  const groups = range.split('||').map((g) => g.trim().split(/\s+/));
  return groups.some((tokens) =>
    tokens.every((token) => {
      const m = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(token);
      const op = m?.[1] || '=';
      const target = parseVersion(m?.[2]);
      if (!target) return false;
      const c = v[0] !== target[0] ? (v[0] < target[0] ? -1 : 1) : v[1] !== target[1] ? (v[1] < target[1] ? -1 : 1) : v[2] !== target[2] ? (v[2] < target[2] ? -1 : 1) : 0;
      if (op === '=') return c === 0;
      if (op === '>') return c > 0;
      if (op === '>=') return c >= 0;
      if (op === '<') return c < 0;
      if (op === '<=') return c <= 0;
      return false;
    })
  );
}

if (fs.existsSync(MATRIX_PATH) && fs.existsSync(FIXTURES_DIR)) {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')))
    .filter((f) => f.engine && f.version && f.pattern && f.pattern !== 'D');
  console.log('\nfixture impact by matrix row (a behavior flip forces a fixture flip — CI enforces this):');
  for (const entry of matrix.entries) {
    const affected = fixtures.filter(
      (f) => f.engine === entry.engine && f.pattern === entry.pattern && inRange(f.version, entry.versionRange)
    );
    if (affected.length === 0) continue;
    const detail = affected
      .map((f) => `${f.id} (expects ${f.expect?.detected ? 'detection' : 'no detection'})`)
      .join(', ');
    console.log(`  ${entry.engine} ${entry.versionRange} ${entry.pattern} [${entry.behavior}] -> ${detail}`);
  }
  const unimpacted = fixtures.filter(
    (f) => !matrix.entries.some((e) => e.engine === f.engine && e.pattern === f.pattern)
  );
  if (unimpacted.length > 0) {
    console.log('  no matrix row (keep an eye): ' + unimpacted.map((f) => f.id).join(', '));
  }
}

if (!dry) {
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`\nsnapshot written to data/upstream-status.json${changed.length > 0 ? ' (CHANGED)' : ''}`);
}

process.exit(changed.length > 0 ? 1 : 0);