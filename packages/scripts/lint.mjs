// Dev-only lint runner. Uses the local eslint binary when the monorepo has
// it installed (npm i -D eslint ...), otherwise falls back to npx --yes so
// CI can lint without committing eslint to the root package.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status ?? 1;
}

const localBin = (name) => {
  const p = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  return fs.existsSync(p) ? p : null;
};

const args = ['packages/unswallow/src', 'packages/unswallow/cli', 'packages/unswallow/test', 'packages/bench'];

const local = localBin('eslint');
if (local) {
  process.exit(run(local, args));
}
process.exit(run('npx', ['--yes', 'eslint@^9', ...args]));
