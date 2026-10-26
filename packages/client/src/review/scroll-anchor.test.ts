// Scroll anchoring keeps the same code under the reader's eye through a rebuild.
// The rows here are the real ones (`buildFileRows`) and the heights the real list
// uses (`computeGeometry`), so "the same code at the same offset" is the pixel
// claim the review makes, not a claim about row indices.

import { describe, expect, it } from 'vitest';
import type { ScmEntry, ScmFileSnapshot, ScmHunk, ScmHunkLine } from '@palmux/shared';
import {
  computeGeometry,
  DEFAULT_CODE_FONT_PX,
  ROW_METRICS,
  type HeightContext,
} from './review-metrics';
import {
  captureAnchor,
  locateAnchor,
  relocateAnchor,
  restoredScrollTop,
  type AnchorLayout,
} from './scroll-anchor';
import { buildFileRows, type Row, type RowsLayout } from './rows';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}`,
  added: 1,
  removed: 1,
  ...over,
});

/** `n` lines of `line <i>`, one per row, with `overrides` replacing some by number. */
const textOf = (n: number, overrides: Record<number, string> = {}): string =>
  `${Array.from({ length: n }, (_, i) => overrides[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

/** A hunk from `[kind, text]` pairs starting at the given old and new line numbers. */
function hunk(oldStart: number, newStart: number, lines: [ScmHunkLine['kind'], string][]): ScmHunk {
  let old = oldStart;
  let now = newStart;
  const out: ScmHunkLine[] = lines.map(([kind, text]) => {
    const line: ScmHunkLine = { kind, text };
    if (kind !== 'add') line.old = old++;
    if (kind !== 'del') line.new = now++;
    return line;
  });
  return {
    oldStart,
    newStart,
    oldLines: out.filter((l) => l.kind !== 'add').length,
    newLines: out.filter((l) => l.kind !== 'del').length,
    header: `@@ -${oldStart} +${newStart} @@`,
    lines: out,
  };
}

function snapshot(
  path: string,
  oldText: string,
  newText: string,
  hunks: ScmHunk[],
): ScmFileSnapshot {
  return {
    path,
    group: 'changes',
    algorithm: 'histogram',
    old: { id: 'o', text: oldText },
    new: { id: 'n', text: newText },
    hunks,
    binary: false,
    tooLarge: false,
    converted: false,
    unmerged: false,
    modes: {},
    attrs: {},
    version: `v-${newText.length}-${hunks.length}`,
  };
}

/**
 * A 100-line file where line 50 was changed: context 47-49, `- old fifty`, `+ new fifty`,
 * context 51-53 (old and new numbering agree).
 */
function middleEdit(path = 'a.ts', newOverrides: Record<number, string> = {}): ScmFileSnapshot {
  const oldText = textOf(100, { 50: 'old fifty' });
  const newText = textOf(100, { 50: 'new fifty', ...newOverrides });
  return snapshot(path, oldText, newText, [
    hunk(47, 47, [
      ['ctx', 'line 47'],
      ['ctx', 'line 48'],
      ['ctx', 'line 49'],
      ['del', 'old fifty'],
      ['add', 'new fifty'],
      ['ctx', 'line 51'],
      ['ctx', 'line 52'],
      ['ctx', 'line 53'],
    ]),
  ]);
}

/** The same file with `inserted` lines added at line 5, which pushes the hunk down. */
function withInsertionAbove(inserted: number): ScmFileSnapshot {
  const added = Array.from({ length: inserted }, (_, i) => `inserted ${i + 1}`);
  const base = middleEdit();
  const lines = base.new.text.split('\n');
  lines.pop();
  const shiftedNew = `${[...lines.slice(0, 4), ...added, ...lines.slice(4)].join('\n')}\n`;
  const oldLines = base.old.text.split('\n');
  oldLines.pop();
  const shiftedOld = `${[...oldLines.slice(0, 4), ...added, ...oldLines.slice(4)].join('\n')}\n`;
  return snapshot('a.ts', shiftedOld, shiftedNew, [
    hunk(47 + inserted, 47 + inserted, [
      ['ctx', 'line 47'],
      ['ctx', 'line 48'],
      ['ctx', 'line 49'],
      ['del', 'old fifty'],
      ['add', 'new fifty'],
      ['ctx', 'line 51'],
      ['ctx', 'line 52'],
      ['ctx', 'line 53'],
    ]),
  ]);
}

const heights = (wrap = false, layout: RowsLayout = 'unified'): HeightContext => ({
  wrap,
  layout,
  width: 0,
  codeFontPx: DEFAULT_CODE_FONT_PX,
  measured: new Map(),
});

/** Several files, in order, as the pane assembles them. */
function layoutOf(
  files: { entry: ScmEntry; snapshot?: ScmFileSnapshot }[],
  layout: RowsLayout = 'unified',
): AnchorLayout {
  const rows: Row[] = [];
  const fileStart: number[] = [];
  for (const file of files) {
    fileStart.push(rows.length);
    rows.push(...buildFileRows(file, { layout }));
  }
  const { offsets } = computeGeometry(rows, heights(false, layout));
  return { rows, offsets, fileStart };
}

const topOf = (layout: AnchorLayout, predicate: (row: Row) => boolean): number => {
  const index = layout.rows.findIndex(predicate);
  if (index < 0) throw new Error('row not found');
  return layout.offsets[index] ?? 0;
};

const isNewLine = (no: number) => (row: Row) =>
  row.type === 'line' && row.side === 'new' && row.no === no;

describe('captureAnchor', () => {
  const layout = layoutOf([{ entry: entry('a.ts'), snapshot: middleEdit() }]);

  it('anchors on the first visible line, and remembers how far into the view it sat', () => {
    // Scrolled so that line 49 is the first row with any part in view, 5px of it hidden.
    const top = topOf(layout, isNewLine(49));
    const anchor = captureAnchor(layout, top + 5);
    expect(anchor).toEqual({ kind: 'line', path: 'a.ts', side: 'new', no: 49, offset: -5 });
  });

  it('skips the headers above the first line of a file', () => {
    // At the very top the first row is the file header; the anchor is its first line.
    const anchor = captureAnchor(layout, 0);
    expect(anchor?.kind).toBe('line');
    if (anchor?.kind !== 'line') return;
    expect(anchor.no).toBe(47);
    // The gap and hunk header sit between the header and the line.
    expect(anchor.offset).toBe(ROW_METRICS.header + ROW_METRICS.gap + ROW_METRICS.hunk);
  });

  it('names a deleted line by its old side', () => {
    const top = topOf(layout, (row) => row.type === 'line' && row.kind === 'del');
    expect(captureAnchor(layout, top)).toMatchObject({ kind: 'line', side: 'old', no: 50 });
  });

  it('anchors a file that is only a placeholder on its header, which stays', () => {
    const two = layoutOf([{ entry: entry('a.ts') }, { entry: entry('b.ts') }]);
    const placeholder = topOf(two, (row) => row.type === 'placeholder' && row.path === 'a.ts');
    const header = topOf(two, (row) => row.type === 'fileHeader' && row.path === 'a.ts');
    const anchor = captureAnchor(two, placeholder + 10);
    expect(anchor).toEqual({
      kind: 'row',
      key: 'a.ts|file',
      path: 'a.ts',
      offset: header - (placeholder + 10),
    });
  });

  it('anchors a file with no lines (a notice) on its row', () => {
    const binary = snapshot('img.png', '', '', []);
    binary.binary = true;
    const only = layoutOf([{ entry: entry('img.png', { binary: true }), snapshot: binary }]);
    const anchor = captureAnchor(only, ROW_METRICS.header + 3);
    expect(anchor).toMatchObject({ kind: 'row', path: 'img.png', key: 'img.png|notice:binary' });
  });

  it('is null for an empty list', () => {
    expect(captureAnchor({ rows: [], offsets: new Float64Array(1), fileStart: [] }, 0)).toBeNull();
  });
});

describe('restoring after a rebuild', () => {
  it('puts the same line back at the same offset when a file above it grows', () => {
    const before = layoutOf([
      { entry: entry('a.ts') },
      { entry: entry('b.ts'), snapshot: middleEdit('b.ts') },
    ]);
    // The reader sits with b.ts line 48 at the top, 7px scrolled into it.
    const scrollTop = topOf(before, (row) => isNewLine(48)(row) && row.path === 'b.ts') + 7;
    const anchor = captureAnchor(before, scrollTop);
    expect(anchor).not.toBeNull();

    // a.ts loads: its placeholder becomes a real diff, pushing b.ts down.
    const after = layoutOf([
      { entry: entry('a.ts'), snapshot: middleEdit('a.ts') },
      { entry: entry('b.ts'), snapshot: middleEdit('b.ts') },
    ]);
    const restored = restoredScrollTop(after, anchor!);
    expect(restored).not.toBeNull();
    const row = topOf(after, (r) => isNewLine(48)(r) && r.path === 'b.ts');
    // The line is exactly 7px into the view, as it was: the view moved down with it.
    expect(row - restored!).toBe(-7);
    expect(restored).toBeGreaterThan(scrollTop);
  });

  it('is a no-op when only rows below change', () => {
    const before = layoutOf([
      { entry: entry('a.ts'), snapshot: middleEdit('a.ts') },
      { entry: entry('b.ts') },
    ]);
    const scrollTop = topOf(before, isNewLine(49)) + 3;
    const anchor = captureAnchor(before, scrollTop)!;
    const after = layoutOf([
      { entry: entry('a.ts'), snapshot: middleEdit('a.ts') },
      { entry: entry('b.ts'), snapshot: middleEdit('b.ts') },
    ]);
    expect(restoredScrollTop(after, anchor)).toBe(scrollTop);
  });

  it('keeps the same file in view when the layout switches', () => {
    const unified = layoutOf([{ entry: entry('a.ts'), snapshot: middleEdit() }], 'unified');
    const scrollTop = topOf(unified, isNewLine(51)) + 2;
    const anchor = captureAnchor(unified, scrollTop)!;
    const split = layoutOf([{ entry: entry('a.ts'), snapshot: middleEdit() }], 'split');
    const index = locateAnchor(split, anchor);
    expect(index).not.toBeNull();
    const row = split.rows[index!];
    expect(row?.type).toBe('split');
    expect(row?.type === 'split' && row.right?.no).toBe(51);
    expect(restoredScrollTop(split, anchor)).toBe((split.offsets[index!] ?? 0) + 2);
  });

  it('keeps a deleted line on its old side across the layout switch', () => {
    const unified = layoutOf([{ entry: entry('a.ts'), snapshot: middleEdit() }]);
    const anchor = captureAnchor(
      unified,
      topOf(unified, (row) => row.type === 'line' && row.kind === 'del'),
    )!;
    const split = layoutOf([{ entry: entry('a.ts'), snapshot: middleEdit() }], 'split');
    const index = locateAnchor(split, anchor)!;
    const row = split.rows[index];
    expect(row?.type === 'split' && row.left?.no).toBe(50);
  });

  it('falls back to the nearest line on its side when the line is in a gap now', () => {
    const lineSixty = {
      kind: 'line' as const,
      path: 'a.ts',
      side: 'new' as const,
      no: 60,
      offset: 0,
    };
    const rows = layoutOf([{ entry: entry('a.ts'), snapshot: middleEdit() }]);
    // Line 60 is hidden between hunks and the trailing gap; line 53 is the closest shown.
    const index = locateAnchor(rows, lineSixty)!;
    const row = rows.rows[index];
    expect(row?.type === 'line' && row.no).toBe(53);
  });

  it('falls back to the file header for a row that vanished, and null for a file that did', () => {
    const rows = layoutOf([{ entry: entry('a.ts'), snapshot: middleEdit() }]);
    expect(
      locateAnchor(rows, { kind: 'row', key: 'a.ts|notice:binary', path: 'a.ts', offset: 0 }),
    ).toBe(0);
    expect(
      locateAnchor(rows, { kind: 'row', key: 'gone|file', path: 'gone', offset: 0 }),
    ).toBeNull();
    expect(restoredScrollTop(rows, { kind: 'row', key: 'x', path: 'gone', offset: 0 })).toBeNull();
  });
});

describe('relocateAnchor: the code is found again by its text', () => {
  const anchorOn = (no: number, side: 'old' | 'new' = 'new') =>
    ({ kind: 'line', path: 'a.ts', side, no, offset: 12 }) as const;

  it('follows a line when ten lines are inserted above it', () => {
    const before = middleEdit();
    const after = withInsertionAbove(10);
    const anchor = relocateAnchor(anchorOn(51), before, after);
    expect(anchor).toEqual({ kind: 'line', path: 'a.ts', side: 'new', no: 61, offset: 12 });
  });

  it('keeps a line in view at the same offset across the rebuild (line 100 becomes 110)', () => {
    const base = textOf(120);
    const long = snapshot('a.ts', base, base, [
      hunk(98, 98, [
        ['ctx', 'line 98'],
        ['ctx', 'line 99'],
        ['del', 'line 100'],
        ['add', 'line 100 changed'],
        ['ctx', 'line 101'],
        ['ctx', 'line 102'],
        ['ctx', 'line 103'],
      ]),
    ]);
    const before = layoutOf([{ entry: entry('a.ts'), snapshot: long }]);
    const scrollTop = topOf(before, isNewLine(101)) + 4;
    const anchor = captureAnchor(before, scrollTop)!;
    expect(anchor).toMatchObject({ kind: 'line', no: 101 });

    const inserted = Array.from({ length: 10 }, (_, i) => `inserted ${i}`);
    const lines = base.split('\n');
    lines.pop();
    const shifted = `${[...lines.slice(0, 4), ...inserted, ...lines.slice(4)].join('\n')}\n`;
    const next = snapshot('a.ts', shifted, shifted, [
      hunk(108, 108, [
        ['ctx', 'line 98'],
        ['ctx', 'line 99'],
        ['del', 'line 100'],
        ['add', 'line 100 changed'],
        ['ctx', 'line 101'],
        ['ctx', 'line 102'],
        ['ctx', 'line 103'],
      ]),
    ]);
    const moved = relocateAnchor(anchor, long, next);
    expect(moved).toMatchObject({ kind: 'line', no: 111 });

    const after = layoutOf([{ entry: entry('a.ts'), snapshot: next }]);
    const restored = restoredScrollTop(after, moved)!;
    // The same code, 4px into the view, though its number changed.
    const row = after.rows[locateAnchor(after, moved)!];
    expect(row?.type === 'line' && row.text).toBe('line 101');
    expect(after.offsets[locateAnchor(after, moved)!]! - restored).toBe(-4);
  });

  it('does not let a line left at its old number beat the real line ten rows down', () => {
    // Line 51 is `}`; after ten inserted lines the old number holds another `}`.
    const oldText = textOf(60, { 50: 'x', 51: '}', 52: 'y' });
    const before = snapshot('a.ts', oldText, oldText, [
      hunk(49, 49, [
        ['ctx', 'line 49'],
        ['ctx', 'x'],
        ['ctx', '}'],
        ['ctx', 'y'],
        ['ctx', 'line 53'],
      ]),
    ]);
    const lines = oldText.split('\n');
    lines.pop();
    // After the insertion below, old line 41 sits at number 51: a decoy `}` there.
    lines[40] = '}';
    const inserted = Array.from({ length: 10 }, (_, i) => `ins ${i}`);
    const newText = `${[...lines.slice(0, 4), ...inserted, ...lines.slice(4)].join('\n')}\n`;
    expect(newText.split('\n')[50]).toBe('}');
    const after = snapshot('a.ts', newText, newText, []);
    const moved = relocateAnchor(anchorOn(51), before, after);
    expect(moved).toMatchObject({ kind: 'line', no: 61 });
  });

  it('falls to the nearest surviving line of its hunk when the line was deleted', () => {
    const before = middleEdit();
    // `new fifty` is gone from the new side; lines 49 and 51 remain around it.
    const newLines = textOf(100, { 50: 'new fifty' }).split('\n');
    newLines.pop();
    newLines.splice(49, 1);
    const after = snapshot('a.ts', before.old.text, `${newLines.join('\n')}\n`, [
      hunk(47, 47, [
        ['ctx', 'line 47'],
        ['ctx', 'line 48'],
        ['ctx', 'line 49'],
        ['del', 'old fifty'],
        ['ctx', 'line 51'],
        ['ctx', 'line 52'],
        ['ctx', 'line 53'],
      ]),
    ]);
    const moved = relocateAnchor(anchorOn(50), before, after);
    expect(moved.kind).toBe('line');
    if (moved.kind !== 'line') return;
    // A neighbour of the same hunk stands in: line 49 keeps its number, 51 moved up to 50.
    expect(newLines[moved.no - 1]).toMatch(/^line (49|51)$/);
  });

  it('falls to the file header when nothing of the file survives', () => {
    const before = middleEdit();
    const after = snapshot('a.ts', '', 'completely different\n', []);
    expect(relocateAnchor(anchorOn(51), before, after)).toEqual({
      kind: 'row',
      key: 'a.ts|file',
      path: 'a.ts',
      offset: 12,
    });
  });

  it('leaves a row anchor and another file’s anchor alone', () => {
    const row = { kind: 'row', key: 'a.ts|file', path: 'a.ts', offset: 3 } as const;
    expect(relocateAnchor(row, middleEdit(), withInsertionAbove(10))).toBe(row);
    const other = { ...anchorOn(51), path: 'b.ts' } as const;
    expect(relocateAnchor(other, middleEdit(), withInsertionAbove(10))).toBe(other);
  });

  it('follows the old side of a deleted line through a change to the new side', () => {
    const before = middleEdit();
    const after = middleEdit('a.ts', { 20: 'edited line twenty' });
    const moved = relocateAnchor(anchorOn(50, 'old'), before, after);
    expect(moved).toMatchObject({ kind: 'line', side: 'old', no: 50 });
  });
});
