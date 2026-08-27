import fs from 'node:fs';
import path from 'node:path';
import { matchesRange, parseRange } from './semver';
import type { EngineId, SwallowMatrixEntry, ToolPattern } from './types';

export interface MatrixFile {
  matrixVersion: string;
  updated: string;
  note?: string;
  entries: SwallowMatrixEntry[];
}

const CWD_MATRIX_PATH = path.join(process.cwd(), 'data', 'engine-matrix.json');

export function loadMatrix(custom?: SwallowMatrixEntry[]): SwallowMatrixEntry[] {
  if (custom && custom.length > 0) return custom;
  try {
    const pkg = require('@unswallow/matrix') as { entries: SwallowMatrixEntry[] };
    if (Array.isArray(pkg.entries)) return pkg.entries;
  } catch {
    // fall through to local paths (monorepo dev without workspace link)
  }
  for (const p of [CWD_MATRIX_PATH]) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const file = JSON.parse(raw) as MatrixFile;
      if (Array.isArray(file.entries)) return file.entries;
    } catch {
      continue;
    }
  }
  return [];
}

export function getMatrixFile(custom?: SwallowMatrixEntry[]): MatrixFile {
  if (custom && custom.length > 0) {
    return { matrixVersion: 'custom', updated: 'n/a', entries: custom };
  }
  try {
    const pkg = require('@unswallow/matrix') as MatrixFile;
    if (pkg && Array.isArray(pkg.entries)) {
      return {
        matrixVersion: pkg.matrixVersion,
        updated: pkg.updated,
        entries: pkg.entries,
      };
    }
  } catch {
    // fall through
  }
  try {
    const raw = fs.readFileSync(CWD_MATRIX_PATH, 'utf8');
    return JSON.parse(raw) as MatrixFile;
  } catch {
    return { matrixVersion: 'none', updated: 'n/a', entries: [] };
  }
}

export function normalizeEngine(hint?: string): EngineId | 'unknown' {
  if (!hint) return 'unknown';
  const h = hint.trim().toLowerCase().replace(/[-_\s.]/g, '');
  if (h === 'vllm') return 'vllm';
  if (h === 'sglang') return 'sglang';
  if (h === 'llamacpp' || h === 'llama') return 'llama.cpp';
  return 'unknown';
}

function comparatorCount(range: string): number {
  const r = parseRange(range);
  if (!r) return 0;
  return r.comparators.reduce((n, group) => Math.max(n, group.length), 0);
}

export function matchMatrixEntry(
  entries: SwallowMatrixEntry[],
  engine: EngineId,
  version: string,
  pattern: ToolPattern
): SwallowMatrixEntry | null {
  const candidates = entries.filter(
    (e) =>
      e.engine === engine &&
      e.pattern === pattern &&
      matchesRange(version, e.versionRange)
  );
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => comparatorCount(b.versionRange) - comparatorCount(a.versionRange)
  );
  return candidates[0];
}