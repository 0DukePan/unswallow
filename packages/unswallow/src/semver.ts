export type ComparatorOp = '=' | '>' | '>=' | '<' | '<=';

export interface Comparator {
  op: ComparatorOp;
  version: number[];
}

export interface VersionRange {
  comparators: Comparator[][];
}

export function parseVersion(v: string): number[] | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  if (!m) return null;
  return [
    parseInt(m[1], 10),
    m[2] ? parseInt(m[2], 10) : 0,
    m[3] ? parseInt(m[3], 10) : 0,
  ];
}

export function parseRange(range: string): VersionRange | null {
  try {
    const orParts = range
      .split('||')
      .map((p) => p.trim())
      .filter(Boolean);
    const comparators = orParts.map((part) =>
      part.split(/\s+/).filter(Boolean).map((token) => {
        if (token === '*') return { op: '>=' as ComparatorOp, version: [0, 0, 0] };
        const m = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(token);
        if (!m) throw new Error('bad comparator');
        const op = (m[1] || '=') as ComparatorOp;
        const version = parseVersion(m[2]);
        if (!version) throw new Error('bad version');
        return { op, version };
      })
    );
    if (comparators.length === 0 || comparators.some((c) => c.length === 0)) {
      return null;
    }
    return { comparators };
  } catch {
    return null;
  }
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export function matchesRange(version: string, range: string): boolean {
  let v = parseVersion(version);
  if (!v) {
    const m = /(\d+(?:\.\d+){0,2})/.exec(version);
    if (m) v = parseVersion(m[1]);
  }
  const r = parseRange(range);
  if (!v || !r) return false;
  return r.comparators.some((andGroup) =>
    andGroup.every((c) => {
      const cmp = compareVersions(v, c.version);
      switch (c.op) {
        case '=':
          return cmp === 0;
        case '>':
          return cmp > 0;
        case '>=':
          return cmp >= 0;
        case '<':
          return cmp < 0;
        case '<=':
          return cmp <= 0;
      }
    })
  );
}