// Dev-only typecheck runner. Uses the local tsc/mypy when available,
// otherwise falls back to npx --yes / a temp-venv mypy so CI can run the
// gate without committing tooling deps to the published packages.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  return r.status ?? 1;
}

function hasPythonModule(name) {
  const r = spawnSync('python', ['-c', `import ${name}`], { stdio: 'ignore', shell: process.platform === 'win32' });
  return r.status === 0;
}

function pythonArgs(module, args) {
  return ['-m', module, ...args];
}

const localBin = (name) => {
  const p = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  return fs.existsSync(p) ? p : null;
};

let code = 0;

// --- TypeScript: typecheck via tsc --noEmit (build already emits; this is the explicit gate)
const tsc = localBin('tsc');
if (tsc) {
  code = code || run(tsc, ['--noEmit', '-p', 'packages/unswallow/tsconfig.json']);
} else {
  code = code || run('npx', ['--yes', 'typescript@^5.7', 'tsc', '--noEmit', '-p', 'packages/unswallow/tsconfig.json']);
}

// --- Python: mypy over the package
if (!hasPythonModule('mypy')) {
  console.error('typecheck: mypy not installed locally — installing into a temporary venv...');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unswallow-typecheck-'));
  const venvPy = path.join(tmp, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const py = run('python', ['-m', 'venv', tmp]);
  code = code || py;
  const inst = run(venvPy, ['-m', 'pip', 'install', '--quiet', 'mypy']);
  code = code || inst;
  const mypy = run(venvPy, pythonArgs('mypy', ['--config-file', 'mypy.ini', 'packages/python/unswallow']));
  code = code || mypy;
} else {
  const mypy = run('python', pythonArgs('mypy', ['--config-file', 'mypy.ini', 'packages/python/unswallow']));
  code = code || mypy;
}

process.exit(code);
