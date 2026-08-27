import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FIXTURES_DIR = path.join(import.meta.dirname, '..', 'fixtures');
const MANIFEST_PATH = path.join(FIXTURES_DIR, '..', 'fixtures.sha256');

const files = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

const lines = files.map((f) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURES_DIR, f))).digest('hex');
  return `${hash}  ${f}`;
});

fs.writeFileSync(MANIFEST_PATH, lines.join('\n') + '\n');
console.log(`pinned ${files.length} fixtures -> bench/fixtures.sha256`);