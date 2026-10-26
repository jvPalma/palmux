// The heights of the rows a review adds for comments: they wrap, so the browser
// measures them, and until it has they are sized by an estimate that must not
// be zero (a zero-height row at the end of a file would be hidden behind its
// neighbour).

import { describe, expect, it } from 'vitest';
import type { ScmComment } from '@palmux/shared';
import {
  codeCharWidth,
  codeLineHeight,
  COMPACT_ROW_METRICS,
  computeGeometry,
  DEFAULT_CODE_FONT_PX,
  estimateRowHeight,
  isMeasuredRow,
  QUOTE_MAX_LINES,
  ROW_METRICS,
  rowHeightOf,
  type HeightContext,
} from './review-metrics';
import type {
  CommentRow,
  EditorRow,
  FileHeaderRow,
  GapRow,
  HunkHeaderRow,
  LineRow,
  NoticeRow,
  PlaceholderRow,
  SplitRow,
  UnplacedRow,
} from './rows';

const ctx = (
  measured = new Map<string, number>(),
  codeFontPx = DEFAULT_CODE_FONT_PX,
): HeightContext => ({
  wrap: false,
  layout: 'unified',
  width: 800,
  codeFontPx,
  measured,
});

const comment = (body: string, lines: string[] = ['x']): ScmComment => ({
  id: 'c',
  path: 'a.ts',
  version: 'worktree',
  side: 'new',
  start: 1,
  end: lines.length,
  lines,
  before: [],
  after: [],
  body,
  createdAt: 1,
  updatedAt: 1,
});

const commentRow = (body: string): CommentRow => ({
  type: 'comment',
  key: 'a.ts|comment:c',
  path: 'a.ts',
  comment: comment(body),
  side: 'new',
  start: 1,
  end: 1,
});
const editorRow: EditorRow = {
  type: 'editor',
  key: 'a.ts|editor:x',
  path: 'a.ts',
  target: { path: 'a.ts', side: 'new', start: 1, end: 1 },
  comment: undefined,
};
const unplacedRow = (lines: string[], body: string): UnplacedRow => ({
  type: 'unplaced',
  key: 'a.ts|unplaced',
  path: 'a.ts',
  items: [{ comment: comment(body, lines), reason: 'outdated', draft: undefined }],
});

describe('the rows a review adds for comments', () => {
  it('are measured by the browser: they wrap, in any layout', () => {
    for (const row of [commentRow('x'), editorRow, unplacedRow(['a'], 'b')]) {
      expect(isMeasuredRow(row, false, 'unified')).toBe(true);
      expect(isMeasuredRow(row, true, 'split')).toBe(true);
    }
  });

  it('are sized by an estimate that grows with the text until they are measured', () => {
    const one = estimateRowHeight(commentRow('one line'), ctx());
    const three = estimateRowHeight(commentRow('a\nb\nc'), ctx());
    expect(one).toBeGreaterThan(ROW_METRICS.line);
    expect(three - one).toBe(2 * ROW_METRICS.line);
    expect(estimateRowHeight(editorRow, ctx())).toBeGreaterThan(3 * ROW_METRICS.line);
  });

  it('size a list of outdated comments by the code it quotes, at most the lines it shows', () => {
    const short = estimateRowHeight(unplacedRow(['a', 'b'], 'x'), ctx());
    const long = estimateRowHeight(
      unplacedRow(
        Array.from({ length: 100 }, () => 'l'),
        'x',
      ),
      ctx(),
    );
    const capped = estimateRowHeight(
      unplacedRow(
        Array.from({ length: QUOTE_MAX_LINES }, () => 'l'),
        'x',
      ),
      ctx(),
    );
    expect(short).toBeLessThan(long);
    expect(long).toBe(capped);
  });

  it('use the height the browser measured once there is one', () => {
    const measured = new Map([['a.ts|comment:c', 123]]);
    expect(rowHeightOf(commentRow('x'), ctx(measured))).toBe(123);
    expect(rowHeightOf(commentRow('x'), ctx())).toBe(estimateRowHeight(commentRow('x'), ctx()));
  });

  it('sizes an errored placeholder for its Retry button', () => {
    expect(ROW_METRICS.error).toBeGreaterThan(ROW_METRICS.line);
  });
});

describe('the height of a line of code follows the code font size', () => {
  it('is exactly ROW_METRICS.line at the default size, so a device that never chose sees no change', () => {
    expect(DEFAULT_CODE_FONT_PX).toBe(12);
    expect(codeLineHeight(DEFAULT_CODE_FONT_PX)).toBe(ROW_METRICS.line);
    expect(codeCharWidth(DEFAULT_CODE_FONT_PX)).toBeCloseTo(7.2, 10);
  });

  it('grows and shrinks with the size, in whole pixels, so rows stay on the pixel grid', () => {
    const heights = [6, 8, 10, 11, 12, 13, 14, 16, 20, 48].map(codeLineHeight);
    expect(heights.every(Number.isInteger)).toBe(true);
    expect(heights).toEqual(heights.toSorted((a, b) => a - b));
    expect(codeLineHeight(11)).toBeLessThan(codeLineHeight(12));
    expect(codeLineHeight(13)).toBeGreaterThan(codeLineHeight(12));
    // Always taller than the glyphs: a line the size of its text would touch the next.
    for (const size of [6, 11, 12, 16, 48]) expect(codeLineHeight(size)).toBeGreaterThan(size);
  });

  const line = (text: string): LineRow => ({
    type: 'line',
    key: 'a.ts|line:1',
    path: 'a.ts',
    kind: 'ctx',
    side: 'new',
    no: 1,
    old: 1,
    new: 1,
    text,
    noEol: false,
    mate: undefined,
  });
  const split = (text: string): SplitRow => ({
    type: 'split',
    key: 'a.ts|split:1',
    path: 'a.ts',
    left: { kind: 'ctx', side: 'old', no: 1, text, noEol: false },
    right: { kind: 'ctx', side: 'new', no: 1, text, noEol: false },
    paired: false,
  });

  it('sizes an unwrapped line, the row a list of them is made of, at the code line height', () => {
    for (const size of [10, 12, 16]) {
      expect(estimateRowHeight(line('x'), ctx(new Map(), size))).toBe(codeLineHeight(size));
    }
  });

  it('sizes a wrapped line by how many rows its text takes at that size', () => {
    const wrapped = (size: number): HeightContext => ({ ...ctx(new Map(), size), wrap: true });
    // 800px at the default 7.2px advance holds 111 columns less the 7 of gutter.
    const text = 'x'.repeat(200);
    const small = estimateRowHeight(line(text), wrapped(12));
    const large = estimateRowHeight(line(text), wrapped(24));
    expect(small).toBe(2 * codeLineHeight(12));
    // Twice the size is twice the advance: more rows, each of them taller.
    expect(large).toBeGreaterThan(small * 2);
    expect(large % codeLineHeight(24)).toBe(0);
  });

  it('sizes a side-by-side row by its taller cell, at the code line height', () => {
    const wrapped = (size: number): HeightContext => ({
      ...ctx(new Map(), size),
      wrap: true,
      layout: 'split',
    });
    expect(estimateRowHeight(split('x'), wrapped(16))).toBe(codeLineHeight(16));
    expect(estimateRowHeight(split('x'.repeat(400)), wrapped(16))).toBeGreaterThan(
      codeLineHeight(16),
    );
  });

  it('leaves the rows that are not code at their own heights', () => {
    for (const size of [8, 12, 24]) {
      expect(estimateRowHeight(editorRow, ctx(new Map(), size))).toBe(
        estimateRowHeight(editorRow, ctx()),
      );
      expect(estimateRowHeight(commentRow('a'), ctx(new Map(), size))).toBe(
        estimateRowHeight(commentRow('a'), ctx()),
      );
    }
  });
});

// ── A phone's rows ─────────────────────────────────────────────────────────────
// The owner (2026-10-26) found the review spent too much height on its structure: a gap
// ("24 hidden lines", two or three buttons) was 32px, a hunk header 24px and a file
// header 40px. On a phone the three are shorter, and nothing else is, so the code keeps
// its size. The heights stay EXACT numbers (the list is given one per row, and anchoring
// and landing add them up), so the compact table is the same kind of object as the first.
describe('the compact rows of a phone', () => {
  const fileHeader: FileHeaderRow = {
    type: 'fileHeader',
    key: 'a.ts|head',
    path: 'a.ts',
    oldPath: undefined,
    status: 'M',
    added: 1,
    removed: 0,
    binary: false,
    collapsed: false,
    loaded: true,
  };
  const gap: GapRow = {
    type: 'gap',
    key: 'a.ts|gap:0',
    path: 'a.ts',
    gapIndex: 0,
    position: 'start',
    size: 24,
    hidden: 24,
    canUp: true,
    canDown: false,
  };
  const hunk: HunkHeaderRow = {
    type: 'hunkHeader',
    key: 'a.ts|hunk:0',
    path: 'a.ts',
    hunkIndex: 0,
    header: '@@ -1,1 +1,1 @@',
    range: '@@ -1,1 +1,1 @@',
  };
  const notice: NoticeRow = {
    type: 'notice',
    key: 'a.ts|notice',
    path: 'a.ts',
    notice: 'binary',
    text: 'Binary file',
  };
  const placeholder: PlaceholderRow = {
    type: 'placeholder',
    key: 'a.ts|placeholder',
    path: 'a.ts',
    height: 120,
  };
  const line: LineRow = {
    type: 'line',
    key: 'a.ts|line:1',
    path: 'a.ts',
    kind: 'ctx',
    side: 'new',
    no: 1,
    text: 'x',
    noEol: false,
    old: 1,
    new: 1,
    mate: undefined,
  };
  const phone = (): HeightContext => ({ ...ctx(), compact: true });

  it('is the desktop table with a shorter header, gap and hunk, and nothing else changed', () => {
    expect(COMPACT_ROW_METRICS).toEqual({ ...ROW_METRICS, header: 36, gap: 28, hunk: 20 });
    expect(COMPACT_ROW_METRICS.header).toBeLessThan(ROW_METRICS.header);
    expect(COMPACT_ROW_METRICS.gap).toBeLessThan(ROW_METRICS.gap);
    expect(COMPACT_ROW_METRICS.hunk).toBeLessThan(ROW_METRICS.hunk);
    expect(COMPACT_ROW_METRICS.line).toBe(ROW_METRICS.line);
    expect(COMPACT_ROW_METRICS.notice).toBe(ROW_METRICS.notice);
    expect(COMPACT_ROW_METRICS.error).toBe(ROW_METRICS.error);
  });

  it('holds a gap and a hunk header to 28px, and a hunk header to one code line', () => {
    expect(estimateRowHeight(gap, phone())).toBeLessThanOrEqual(28);
    expect(estimateRowHeight(hunk, phone())).toBeLessThanOrEqual(28);
    expect(estimateRowHeight(hunk, phone())).toBe(ROW_METRICS.line);
  });

  it.each([
    ['a file header', fileHeader, 40, 36],
    ['a gap', gap, 32, 28],
    ['a hunk header', hunk, 24, 20],
  ])('sizes %s at %ipx on a desktop and %ipx on a phone', (_, row, desktop, mobile) => {
    expect(estimateRowHeight(row, ctx())).toBe(desktop);
    expect(estimateRowHeight(row, { ...ctx(), compact: false })).toBe(desktop);
    expect(estimateRowHeight(row, phone())).toBe(mobile);
  });

  it('leaves a notice, a placeholder, a code line and a comment as they are', () => {
    for (const row of [notice, placeholder, line, commentRow('one line'), editorRow]) {
      expect(estimateRowHeight(row, phone()), row.type).toBe(estimateRowHeight(row, ctx()));
    }
  });

  it('sums into the geometry the list is given, so more lines fit the same height', () => {
    const rows = [fileHeader, gap, hunk, line, line, line];
    const desktop = computeGeometry(rows, ctx());
    const small = computeGeometry(rows, phone());
    expect([...desktop.sizes]).toEqual([40, 32, 24, 20, 20, 20]);
    expect([...small.sizes]).toEqual([36, 28, 20, 20, 20, 20]);
    // The offsets are the running totals of those sizes, which anchoring reads.
    expect(small.offsets[rows.length]).toBe(36 + 28 + 20 + 3 * 20);
    expect(small.offsets[rows.length]).toBeLessThan(desktop.offsets[rows.length] ?? 0);
  });

  it('keeps a measured row at what the browser measured, compact or not', () => {
    const measured = new Map([[notice.key, 52]]);
    expect(rowHeightOf(notice, { ...phone(), measured })).toBe(52);
  });
});
