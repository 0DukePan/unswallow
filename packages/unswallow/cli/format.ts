const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function wrap(code: string) {
  return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const fg = {
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  magenta: wrap('35'),
  dim: wrap('2'),
  bold: wrap('1'),
  underline: wrap('4'),
};

export function bar(frac: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
  return rows
    .map((r) => r.map((cell, i) => pad(cell, widths[i])).join('  ').trimEnd())
    .join('\n');
}

export function prettyJson(value: unknown, maxLen = 400): string {
  const s = JSON.stringify(value, null, 2);
  return s.length > maxLen ? s.slice(0, maxLen) + '\n… (truncated)' : s;
}