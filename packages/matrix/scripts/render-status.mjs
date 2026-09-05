#!/usr/bin/env node
// Renders packages/matrix/status/index.html from the committed matrix data —
// a public, auto-updating "current swallow status across engines" page.
// Run locally: node packages/matrix/scripts/render-status.mjs
// In CI: the status-page.yml workflow renders + deploys it to GitHub Pages.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dir, '..', 'data');
const outDir = path.join(dir, '..', 'status');

const matrix = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-matrix.json'), 'utf8'));
const upstream = JSON.parse(fs.readFileSync(path.join(dataDir, 'upstream-status.json'), 'utf8'));

const behaviorColor = {
  swallow: '#b42318',
  partial: '#b54708',
  resolved: '#067647',
};
const behaviorBg = {
  swallow: '#fef3f2',
  partial: '#fffaeb',
  resolved: '#ecfdf3',
};

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const matrixRows = matrix.entries
  .map(
    (e) => `
      <tr>
        <td><code>${esc(e.engine ?? e.harness ?? '—')}</code></td>
        <td><code>${esc(e.versionRange)}</code></td>
        <td><code>${esc(e.pattern)}</code></td>
        <td><span class="badge" style="color:${behaviorColor[e.behavior]};background:${behaviorBg[e.behavior]}">${esc(e.behavior)}</span></td>
        <td>${e.verified ? '<strong>verified</strong>' : 'reported'}</td>
        <td><a href="${esc(e.source)}">${esc(e.source.replace('https://github.com/', ''))}</a></td>
      </tr>`
  )
  .join('');

const upstreamRows = Object.values(upstream)
  .sort((a, b) => (a.label < b.label ? -1 : 1))
  .map(
    (u) => `
      <tr>
        <td><a href="${esc(u.issueUrl)}">${esc(u.label)}</a></td>
        <td><span class="badge ${u.state === 'open' ? 'open' : 'closed'}">${esc(u.state)}</span></td>
        <td>${esc(u.comments)}</td>
        <td>${esc((u.updatedAt ?? '').slice(0, 10))}</td>
      </tr>`
  )
  .join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>unswallow — engine status matrix</title>
<style>
  :root { color-scheme: light; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .sub { color: #555; margin-bottom: 2rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  th { border-bottom: 2px solid #ccc; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .8rem; font-weight: 600; }
  .badge.open { background: #ecfdf3; color: #067647; }
  .badge.closed { background: #f2f4f7; color: #475467; }
  code { background: #f2f4f7; padding: .1rem .3rem; border-radius: 4px; }
  .foot { margin-top: 3rem; color: #888; font-size: .8rem; }
</style>
</head>
<body>
<h1>unswallow — reasoning-channel swallow status</h1>
<p class="sub">Current engine/version behavior matrix for the tool-call swallow bug class (vLLM, SGLang, llama.cpp). Every row is sourced from its linked upstream report; <em>verified</em> means independently reproduced by a maintainer. Generated from <code>engine-matrix.json</code> (matrix v${esc(matrix.matrixVersion)}, updated ${esc(matrix.updated)}).</p>

<h2>Engine matrix</h2>
<table>
  <thead><tr><th>engine</th><th>version range</th><th>pattern</th><th>behavior</th><th>verification</th><th>source</th></tr></thead>
  <tbody>${matrixRows}</tbody>
</table>

<h2>Upstream threads</h2>
<table>
  <thead><tr><th>thread</th><th>state</th><th>comments</th><th>last activity</th></tr></thead>
  <tbody>${upstreamRows}</tbody>
</table>

<p class="foot">Generated ${new Date().toISOString().slice(0, 10)} by <code>packages/matrix/scripts/render-status.mjs</code>. The page is regenerated weekly and on matrix data changes. Library + recovery: <a href="https://github.com/0DukePan/unswallow">github.com/0DukePan/unswallow</a>.</p>
</body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(`status page written to ${path.join(outDir, 'index.html')}`);