// ── One line of code, as the review draws it ───────────────────────────────────
//
// A line reaches the screen in one of two shapes: plain text, and Monaco's coloured
// HTML once `colorize` has run. Both must lay out identically, or the swap from one
// to the other would change a row's height. Monaco expands a tab to spaces at
// 4-column stops and writes every space as `&#160;`, so plain text is expanded the
// same way here and the coloured markup has its `&#160;` turned back into ordinary
// spaces, which `white-space: pre-wrap` then preserves in both.
//
// Inner marks (the changed characters between a paired removed and added line) are
// computed on the SOURCE text, so their ranges are mapped through the tab expansion
// and spliced into whichever shape is drawn. Into Monaco's markup they are spliced
// only if its decoded text is exactly the line: a markup that disagrees with the
// text it claims to colour is drawn without marks, never with the marks misplaced.
// Nothing from the file is inserted as markup: plain text goes through React, and
// the markup is Monaco's own escaped output.

import type { TextRange } from './inner-diff';

export const TAB_SIZE = 4;

export const MARK_CLASS = 'rv-mark';

/** What is drawn for a line: carriage returns are not drawn (Monaco's colouring drops them too). */
export const displayText = (text: string): string => text.replace(/\r/g, '');

export interface Expanded {
  /** The text with each tab replaced by the spaces up to the next 4-column stop. */
  text: string;
  /** `map[i]` is where source character `i` starts; `map[text.length]` is the end. */
  map: number[];
}

export function expandTabs(source: string): Expanded {
  if (!source.includes('\t')) {
    return { text: source, map: Array.from({ length: source.length + 1 }, (_, i) => i) };
  }
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    map.push(text.length);
    const char = source[i] as string;
    text += char === '\t' ? ' '.repeat(TAB_SIZE - (text.length % TAB_SIZE)) : char;
  }
  map.push(text.length);
  return { text, map };
}

/** Columns a line takes once its tabs are expanded. */
export function visualLength(source: string): number {
  if (!source.includes('\t')) return source.length;
  let length = 0;
  for (const char of source) {
    length += char === '\t' ? TAB_SIZE - (length % TAB_SIZE) : char.length;
  }
  return length;
}

/** Source ranges as expanded ranges, empty ones dropped, in order. */
export function toVisualRanges(map: readonly number[], ranges: readonly TextRange[]): TextRange[] {
  const visual: TextRange[] = [];
  for (const range of ranges) {
    const start = map[range.start];
    const end = map[range.end];
    if (start !== undefined && end !== undefined && end > start) visual.push({ start, end });
  }
  return visual;
}

export interface Segment {
  text: string;
  marked: boolean;
  /** Where the segment starts in the line: a key that is the same wherever the line is drawn. */
  start: number;
}

/** Plain text cut at the range edges, for React to render. */
export function plainSegments(text: string, ranges: readonly TextRange[]): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) {
      segments.push({ text: text.slice(at, range.start), marked: false, start: at });
    }
    segments.push({ text: text.slice(range.start, range.end), marked: true, start: range.start });
    at = range.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), marked: false, start: at });
  return segments;
}

/** Monaco writes every space as `&#160;`; the review draws ordinary spaces (see above). */
export const normalizeColored = (html: string): string => html.replaceAll('&#160;', ' ');

const NAMED: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodeEntity(entity: string): string | null {
  const body = entity.slice(1, -1);
  if (body.startsWith('#x') || body.startsWith('#X')) {
    const code = Number.parseInt(body.slice(2), 16);
    return Number.isNaN(code) ? null : String.fromCodePoint(code);
  }
  if (body.startsWith('#')) {
    const code = Number.parseInt(body.slice(1), 10);
    return Number.isNaN(code) ? null : String.fromCodePoint(code);
  }
  return NAMED[body] ?? null;
}

// An opening span, a closing span, one entity, a run of text, or a stray `<` / `&`.
const TOKEN = /<span\b[^>]*>|<\/span>|&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);|[^<&]+|[<&]/g;

const MARK_OPEN = `<span class="${MARK_CLASS}">`;

/**
 * Wrap the characters in `ranges` (expanded columns) in Monaco's coloured markup of
 * the line `visual`. Returns the markup unchanged when `ranges` is empty or when
 * the markup's own text is not exactly `visual`.
 */
export function markColored(html: string, visual: string, ranges: readonly TextRange[]): string {
  if (ranges.length === 0) return html;

  let out = '';
  let decoded = '';
  let position = 0;
  let next = 0;
  let inMark = false;
  const marked = (at: number): boolean => {
    while (next < ranges.length && (ranges[next]?.end ?? 0) <= at) next++;
    const range = ranges[next];
    return range !== undefined && at >= range.start && at < range.end;
  };
  const unit = (raw: string, char: string): void => {
    const on = marked(position);
    if (on !== inMark) {
      out += on ? MARK_OPEN : '</span>';
      inMark = on;
    }
    out += raw;
    decoded += char;
    position += char.length;
  };

  for (const match of html.matchAll(TOKEN)) {
    const token = match[0];
    if (token.startsWith('<span') || token === '</span>') {
      // A mark cannot straddle a colour span: close it here, and the next marked
      // character opens a new one.
      if (inMark) {
        out += '</span>';
        inMark = false;
      }
      out += token;
    } else if (token.length > 1 && token.startsWith('&')) {
      const char = decodeEntity(token);
      if (char === null) return html;
      unit(token, char);
    } else if (token === '<' || token === '&') {
      return html;
    } else {
      for (const char of token) unit(char, char);
    }
  }
  if (inMark) out += '</span>';
  return decoded === visual ? out : html;
}
