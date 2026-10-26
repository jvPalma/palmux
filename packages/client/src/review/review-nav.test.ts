// The pure half of navigation: which row is the next change, which file is next.
// The rows are built the way the model builds them, from real hunks, so a change
// is whatever `buildFileRows` made one.

import { describe, expect, it } from 'vitest';
import type { ScmEntry, ScmFileSnapshot, ScmHunk, ScmHunkLine } from '@palmux/shared';
import { computeGeometry, DEFAULT_CODE_FONT_PX, type HeightContext } from './review-metrics';
import {
  findChange,
  findFile,
  jumpTop,
  NAV_CONTEXT_PX,
  changeStops,
  type NavView,
} from './review-nav';
import { buildFileRows, type Row } from './rows';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}`,
  added: 1,
  removed: 1,
  ...over,
});

function hunk(lines: [ScmHunkLine['kind'], string][], start = 1): ScmHunk {
  let old = start;
  let now = start;
  const out = lines.map(([kind, text]): ScmHunkLine => {
    const line: ScmHunkLine = { kind, text };
    if (kind !== 'add') line.old = old++;
    if (kind !== 'del') line.new = now++;
    return line;
  });
  return {
    oldStart: start,
    newStart: start,
    oldLines: out.filter((l) => l.kind !== 'add').length,
    newLines: out.filter((l) => l.kind !== 'del').length,
    header: '',
    lines: out,
  };
}

const snapshot = (path: string, hunks: ScmHunk[], text = ''): ScmFileSnapshot => ({
  path,
  group: 'changes',
  algorithm: 'histogram',
  old: { id: 'o', text },
  new: { id: 'n', text },
  hunks,
  binary: false,
  tooLarge: false,
  converted: false,
  unmerged: false,
  modes: {},
  attrs: {},
  version: `v-${path}`,
});

const TWO_CHANGES = (path: string): ScmFileSnapshot =>
  snapshot(
    path,
    [
      hunk([
        ['ctx', 'a'],
        ['del', 'b'],
        ['add', 'B'],
        ['ctx', 'c'],
        ['ctx', 'd'],
        ['add', 'e'],
        ['ctx', 'f'],
      ]),
    ],
    'a\nB\nc\nd\ne\nf\n',
  );

interface File {
  entry: ScmEntry;
  snapshot?: ScmFileSnapshot;
  collapsed?: boolean;
}

function view(
  files: File[],
  scrollTop = 0,
  landed?: NavView['landed'],
  layout: 'unified' | 'split' = 'unified',
): NavView {
  const rows: Row[] = [];
  const fileStart: number[] = [];
  for (const f of files) {
    fileStart.push(rows.length);
    rows.push(
      ...buildFileRows(
        { entry: f.entry, snapshot: f.snapshot },
        { layout, collapsed: f.collapsed === true },
      ),
    );
  }
  const ctx: HeightContext = {
    wrap: false,
    layout,
    width: 0,
    codeFontPx: DEFAULT_CODE_FONT_PX,
    measured: new Map(),
  };
  const { offsets } = computeGeometry(rows, ctx);
  return { rows, fileStart, offsets, scrollTop, landed };
}

const keyOf = (v: NavView, key: string): number => v.rows.findIndex((r) => r.key === key);

describe('where a change starts', () => {
  it('is the first changed row of each block, not each changed line', () => {
    const v = view([{ entry: entry('a.ts'), snapshot: TWO_CHANGES('a.ts') }]);
    const stops = changeStops(v.rows, 0, v.rows.length);
    expect(stops.map((i) => v.rows[i]?.key)).toEqual(['a.ts|0:1', 'a.ts|0:5']);
  });

  it('reads both layouts the same way', () => {
    const v = view(
      [{ entry: entry('a.ts'), snapshot: TWO_CHANGES('a.ts') }],
      0,
      undefined,
      'split',
    );
    const stops = changeStops(v.rows, 0, v.rows.length);
    expect(stops).toHaveLength(2);
  });

  it('is the header for a file with no changed line to show', () => {
    const binary = { ...snapshot('b.bin', []), binary: true };
    const v = view([{ entry: entry('b.bin'), snapshot: binary }]);
    expect(changeStops(v.rows, 0, v.rows.length)).toEqual([0]);
  });
});

describe('Next change crosses a file', () => {
  const files = (): File[] => [
    { entry: entry('a.ts'), snapshot: TWO_CHANGES('a.ts') },
    { entry: entry('b.ts'), snapshot: TWO_CHANGES('b.ts') },
  ];

  it('goes from one change to the next inside a file', () => {
    const v = view(files());
    expect(findChange(v, 1, () => false)).toEqual({ kind: 'row', key: 'a.ts|0:1', path: 'a.ts' });
    const first = keyOf(v, 'a.ts|0:1');
    const at = view(files(), jumpTop(v, first), { key: 'a.ts|0:1', top: jumpTop(v, first) });
    expect(findChange(at, 1, () => false)).toEqual({ kind: 'row', key: 'a.ts|0:5', path: 'a.ts' });
  });

  it('lands on the next file’s first change from a file’s last one', () => {
    const v = view(files());
    const last = keyOf(v, 'a.ts|0:5');
    const at = view(files(), jumpTop(v, last), { key: 'a.ts|0:5', top: jumpTop(v, last) });
    expect(findChange(at, 1, () => false)).toEqual({ kind: 'row', key: 'b.ts|0:1', path: 'b.ts' });
  });

  it('goes back from a file’s first change to the previous file’s last one', () => {
    const v = view(files());
    const first = keyOf(v, 'b.ts|0:1');
    const at = view(files(), jumpTop(v, first), { key: 'b.ts|0:1', top: jumpTop(v, first) });
    expect(findChange(at, -1, () => false)).toEqual({ kind: 'row', key: 'a.ts|0:5', path: 'a.ts' });
  });

  it('has nothing past the last change, or before the first', () => {
    const v = view(files());
    const last = keyOf(v, 'b.ts|0:5');
    const end = view(files(), jumpTop(v, last), { key: 'b.ts|0:5', top: jumpTop(v, last) });
    expect(findChange(end, 1, () => false)).toBeNull();
    const first = keyOf(v, 'a.ts|0:1');
    const start = view(files(), jumpTop(v, first), { key: 'a.ts|0:1', top: jumpTop(v, first) });
    expect(findChange(start, -1, () => false)).toBeNull();
  });

  it('is not fooled by the context a jump scrolls above its change', () => {
    // After the jump the top row is a context row ABOVE the change; reading it as the
    // position would make "next" land on the same change again.
    const v = view(files());
    const stop = keyOf(v, 'a.ts|0:1');
    const top = jumpTop(v, stop);
    expect(top).toBeLessThan(v.offsets[stop] ?? 0);
    const at = view(files(), top, { key: 'a.ts|0:1', top });
    expect(findChange(at, 1, () => false)).toMatchObject({ key: 'a.ts|0:5' });
    expect(findChange(at, -1, () => false)).toBeNull();
  });

  it('reads the position from the scroll offset once the reader has scrolled', () => {
    const v = view(files());
    const stop = keyOf(v, 'a.ts|0:1');
    const landed = { key: 'a.ts|0:1', top: jumpTop(v, stop) };
    // The reader scrolled well past where the jump left the view.
    const second = keyOf(v, 'a.ts|0:5');
    const moved = view(files(), (v.offsets[second] ?? 0) + 1, landed);
    expect(findChange(moved, -1, () => false)).toMatchObject({ key: 'a.ts|0:5' });
    expect(findChange(moved, 1, () => false)).toMatchObject({ key: 'b.ts|0:1' });
  });
});

describe('a file that has not loaded', () => {
  const unloaded = (): File[] => [
    { entry: entry('a.ts'), snapshot: TWO_CHANGES('a.ts') },
    { entry: entry('b.ts') },
  ];

  it('is loaded before the view moves into it', () => {
    const v = view(unloaded());
    const last = keyOf(v, 'a.ts|0:5');
    const at = view(unloaded(), jumpTop(v, last), { key: 'a.ts|0:5', top: jumpTop(v, last) });
    expect(findChange(at, 1, () => true)).toEqual({ kind: 'load', path: 'b.ts' });
  });

  it('stops at its header when it has no text change to load (binary, mode only)', () => {
    const v = view(unloaded());
    const last = keyOf(v, 'a.ts|0:5');
    const at = view(unloaded(), jumpTop(v, last), { key: 'a.ts|0:5', top: jumpTop(v, last) });
    expect(findChange(at, 1, () => false)).toEqual({ kind: 'row', key: 'b.ts|file', path: 'b.ts' });
  });

  it('loads the previous file when stepping back into it', () => {
    const files: File[] = [
      { entry: entry('a.ts') },
      { entry: entry('b.ts'), snapshot: TWO_CHANGES('b.ts') },
    ];
    const v = view(files);
    const first = keyOf(v, 'b.ts|0:1');
    const at = view(files, jumpTop(v, first), { key: 'b.ts|0:1', top: jumpTop(v, first) });
    expect(findChange(at, -1, () => true)).toEqual({ kind: 'load', path: 'a.ts' });
  });

  it('counts a collapsed file as one change at its header, without loading it', () => {
    const files: File[] = [
      { entry: entry('a.ts'), snapshot: TWO_CHANGES('a.ts') },
      { entry: entry('b.ts'), collapsed: true },
    ];
    const v = view(files);
    const last = keyOf(v, 'a.ts|0:5');
    const at = view(files, jumpTop(v, last), { key: 'a.ts|0:5', top: jumpTop(v, last) });
    expect(findChange(at, 1, () => true)).toEqual({ kind: 'row', key: 'b.ts|file', path: 'b.ts' });
  });
});

describe('next and previous file', () => {
  const files = (): File[] => [
    { entry: entry('a.ts'), snapshot: TWO_CHANGES('a.ts') },
    { entry: entry('b.ts'), snapshot: TWO_CHANGES('b.ts') },
    { entry: entry('c.ts'), snapshot: TWO_CHANGES('c.ts') },
  ];

  it('steps to the next file, and stops at the last', () => {
    expect(findFile(view(files()), 1)).toBe(1);
    const v = view(files());
    const atLast = view(files(), v.offsets[v.fileStart[2] ?? 0] ?? 0);
    expect(findFile(atLast, 1)).toBeNull();
  });

  it('goes back to the start of the file the view is inside, then to the file before', () => {
    const v = view(files());
    const inB = (v.offsets[v.fileStart[1] ?? 0] ?? 0) + 40;
    expect(findFile(view(files(), inB), -1)).toBe(1);
    const atB = v.offsets[v.fileStart[1] ?? 0] ?? 0;
    expect(findFile(view(files(), atB), -1)).toBe(0);
    expect(findFile(view(files(), 0), -1)).toBeNull();
  });

  it('follows where the last jump landed when the list could not scroll that far', () => {
    // The last file is shorter than the view, so its header could not reach the top.
    const v = view(files());
    const header = v.fileStart[2] ?? 0;
    const clamped = (v.offsets[header] ?? 0) - 30;
    const at = view(files(), clamped, { key: v.rows[header]?.key ?? '', top: clamped });
    expect(findFile(at, -1)).toBe(1);
    expect(findFile(at, 1)).toBeNull();
  });

  it('has no file to step to in an empty review', () => {
    expect(findFile(view([]), 1)).toBeNull();
    expect(findChange(view([]), 1, () => false)).toBeNull();
  });
});

describe('the scroll a jump goes to', () => {
  it('leaves context above a change but never reaches above its file’s header', () => {
    const v = view([
      { entry: entry('a.ts'), snapshot: TWO_CHANGES('a.ts') },
      { entry: entry('b.ts'), snapshot: TWO_CHANGES('b.ts') },
    ]);
    const header = v.fileStart[1] ?? 0;
    expect(jumpTop(v, header)).toBe(v.offsets[header]);
    const stop = keyOf(v, 'b.ts|0:1');
    expect(jumpTop(v, stop)).toBeGreaterThanOrEqual(v.offsets[header] ?? 0);
    expect(jumpTop(v, stop)).toBeGreaterThanOrEqual((v.offsets[stop] ?? 0) - NAV_CONTEXT_PX);
  });
});
