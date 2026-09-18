import type { ChannelSource, RawMessage } from './types';

export const REASONING_FIELDS: ChannelSource[] = [
  'reasoning',
  'reasoning_content',
  'thinking',
  'thought',
];

export interface Region {
  id: number;
  channel: ChannelSource;
  source: 'field' | 'think-block' | 'leak';
  text: string;
}

const THINK_TAG = /<\s*(\/?)\s*([a-zA-Z0-9_.:-]*?\s*(?:think|response))[^>]*>/gi;

export function splitThinkBlocks(text: string, startId = 0): Region[] {
  const out: Region[] = [];
  let nextId = startId;
  THINK_TAG.lastIndex = 0;
  let depth = 0;
  let last = 0;
  let blockStart = 0;
  let m: RegExpExecArray | null;
  while ((m = THINK_TAG.exec(text)) !== null) {
    const isClose = m[1] === '/';
    const name = m[2].trim();
    const isResponse = /response$/i.test(name) || /response/i.test(name);
    const isOpenThink = !isClose && !isResponse;
    if (isOpenThink) {
      if (depth === 0) {
        if (m.index > last) {
          out.push({ id: nextId++, channel: 'content', source: 'field', text: text.slice(last, m.index) });
        }
        blockStart = m.index;
      }
      depth++;
    } else {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          out.push({
            id: nextId++,
            channel: 'thinking',
            source: 'think-block',
            text: text.slice(blockStart, m.index + m[0].length),
          });
          last = m.index + m[0].length;
        }
      }
    }
  }
  if (depth > 0) {
    out.push({ id: nextId++, channel: 'thinking', source: 'leak', text: text.slice(blockStart) });
    last = text.length;
  }
  if (last < text.length) {
    out.push({ id: nextId++, channel: 'content', source: 'field', text: text.slice(last) });
  }
  if (out.length === 0 && text.length > 0) {
    out.push({ id: nextId++, channel: 'content', source: 'field', text });
  }
  return out;
}

export function extractRegions(message: RawMessage, additionalFields?: string[]): Region[] {
  const regions: Region[] = [];
  const fields = [...REASONING_FIELDS, ...(additionalFields ?? [])];
  for (const f of fields) {
    const v = (message as Record<string, unknown>)[f];
    if (typeof v === 'string' && v.length > 0) {
      regions.push({ id: regions.length, channel: f as ChannelSource, source: 'field', text: v });
    }
  }
  const content = typeof message.content === 'string' ? message.content : '';
  if (content.length > 0) {
    regions.push(...splitThinkBlocks(content, regions.length));
  }
  return regions;
}