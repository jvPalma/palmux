import { describe, expect, it } from 'vitest';
import type { ScmEntry, ScmFileSnapshot, ScmHunk, ScmHunkLine } from '@palmux/shared';
import { splitLines } from './anchor';
import {
  buildFileRows,
  DEFAULT_LINE_HEIGHT,
  ERROR_ROW_HEIGHT,
  estimatePlaceholderHeight,
  expandGap,
  GAP_STEP,
  rowLine,
  type GapReveals,
  type GapRow,
  type NoticeRow,
  type Row,
  type RowsLayout,
  type SplitRow,
} from './rows';

// ── fixtures ──────────────────────────────────────────────────────────────────

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

type Op = { op: 'eq' | 'del' | 'add'; text: string };

/** A line diff with each change block's deletions ahead of its additions, as git writes it. */
function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: 'eq', text: must(a[i]) });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      ops.push({ op: 'del', text: must(a[i]) });
      i++;
    } else {
      ops.push({ op: 'add', text: must(b[j]) });
      j++;
    }
  }
  return ops;
}

/** Hunks the way `git diff -U3` writes them, zero-length ranges included. */
function makeHunks(
  oldLines: readonly string[],
  newLines: readonly string[],
  context = 3,
): ScmHunk[] {
  const ops = diffOps(oldLines, newLines);
  const near = ops.map((_, index) =>
    ops.some((o, k) => o.op !== 'eq' && Math.abs(k - index) <= context),
  );
  const hunks: ScmHunk[] = [];
  let index = 0;
  let oldBefore = 0;
  let newBefore = 0;
  while (index < ops.length) {
    if (!near[index]) {
      if (ops[index]!.op !== 'add') oldBefore++;
      if (ops[index]!.op !== 'del') newBefore++;
      index++;
      continue;
    }
    const lines: ScmHunkLine[] = [];
    let oldNo = oldBefore;
    let newNo = newBefore;
    while (index < ops.length && near[index]) {
      const { op, text } = ops[index]!;
      if (op === 'eq') lines.push({ kind: 'ctx', old: ++oldNo, new: ++newNo, text });
      else if (op === 'del') lines.push({ kind: 'del', old: ++oldNo, text });
      else lines.push({ kind: 'add', new: ++newNo, text });
      index++;
    }
    const oldCount = oldNo - oldBefore;
    const newCount = newNo - newBefore;
    const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
    const newStart = newCount === 0 ? newBefore : newBefore + 1;
    hunks.push({
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines,
    });
    oldBefore = oldNo;
    newBefore = newNo;
  }
  return hunks;
}

const textOf = (lines: readonly string[]): string => (lines.length ? `${lines.join('\n')}\n` : '');

function snapshotOf(
  oldLines: readonly string[],
  newLines: readonly string[],
  over: Partial<ScmFileSnapshot> = {},
): ScmFileSnapshot {
  return {
    path: 'src/a.ts',
    group: 'changes',
    algorithm: 'histogram',
    old: { id: oldLines.length ? 'old-oid' : 'absent', text: textOf(oldLines) },
    new: { id: newLines.length ? 'new-oid' : 'absent', text: textOf(newLines) },
    hunks: makeHunks(oldLines, newLines),
    binary: false,
    tooLarge: false,
    converted: false,
    unmerged: false,
    modes: {},
    attrs: {},
    version: 'v1',
    ...over,
  };
}

function entryOf(over: Partial<ScmEntry> = {}): ScmEntry {
  return { path: 'src/a.ts', kind: 'ordinary', status: 'M', fp: 'fp1', ...over };
}

const numbered = (count: number, prefix = 'line'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

const build = (
  snapshot: ScmFileSnapshot | undefined,
  layout: RowsLayout = 'unified',
  extra: Partial<Parameters<typeof buildFileRows>[1]> = {},
  entry: ScmEntry = entryOf(),
): Row[] => buildFileRows({ entry, snapshot }, { layout, ...extra });

const ofType = <T extends Row['type']>(
  rows: readonly Row[],
  type: T,
): Extract<Row, { type: T }>[] =>
  rows.filter((row): row is Extract<Row, { type: T }> => row.type === type);

const gaps = (rows: readonly Row[]): GapRow[] => ofType(rows, 'gap');

/** `old → new` for one line replaced in a 100-line file. */
function editAt(line: number, count = 100): { before: string[]; after: string[] } {
  const before = numbered(count);
  const after = before.map((text, i) => (i === line - 1 ? `${text} edited` : text));
  return { before, after };
}

// ── the file header and the placeholder ───────────────────────────────────────

describe('fileHeader', () => {
  it('names the file, its status and its counts', () => {
    const rows = build(undefined, 'unified', {}, entryOf({ added: 3, removed: 1 }));
    expect(rows[0]).toEqual({
      type: 'fileHeader',
      key: 'src/a.ts|file',
      path: 'src/a.ts',
      oldPath: undefined,
      status: 'M',
      added: 3,
      removed: 1,
      binary: false,
      collapsed: false,
      loaded: false,
    });
  });

  it('counts from the hunks when status has no counts (an untracked file)', () => {
    const entry = entryOf({ kind: 'untracked', status: '?' });
    const rows = build(snapshotOf([], numbered(4)), 'unified', {}, entry);
    expect(rows[0]).toMatchObject({ added: 4, removed: 0, loaded: true });
  });

  it('keeps the counts status gave, even once loaded', () => {
    const { before, after } = editAt(5);
    const rows = build(snapshotOf(before, after), 'unified', {}, entryOf({ added: 9, removed: 9 }));
    expect(rows[0]).toMatchObject({ added: 9, removed: 9 });
  });

  it('carries the old path of a rename', () => {
    const entry = entryOf({ kind: 'rename', status: 'R', oldPath: 'src/old.ts' });
    expect(build(undefined, 'unified', {}, entry)[0]).toMatchObject({ oldPath: 'src/old.ts' });
  });

  it('takes the binary flag from the snapshot, else from status', () => {
    expect(build(undefined, 'unified', {}, entryOf({ binary: true }))[0]).toMatchObject({
      binary: true,
    });
    const snapshot = snapshotOf([], [], { binary: true });
    expect(build(snapshot)[0]).toMatchObject({ binary: true });
  });

  it('stops at the header when the file is collapsed', () => {
    const { before, after } = editAt(5);
    const rows = build(snapshotOf(before, after), 'unified', { collapsed: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'fileHeader', collapsed: true });
    expect(build(undefined, 'unified', { collapsed: true })).toHaveLength(1);
  });
});

describe('placeholder', () => {
  const placeholder = (rows: Row[]) => must(ofType(rows, 'placeholder')[0]);

  it('stands in for a file that is not fetched yet', () => {
    const rows = build(undefined, 'unified', {}, entryOf({ added: 10, removed: 4 }));
    expect(rows.map((r) => r.type)).toEqual(['fileHeader', 'placeholder']);
    expect(placeholder(rows).key).toBe('src/a.ts|placeholder');
  });

  it('estimates its height from the status counts plus context', () => {
    // 10 + 4 changed lines and three lines of context above and below.
    const entry = entryOf({ added: 10, removed: 4 });
    expect(placeholder(build(undefined, 'unified', {}, entry)).height).toBe(
      (14 + 6) * DEFAULT_LINE_HEIGHT,
    );
    expect(placeholder(build(undefined, 'unified', { lineHeight: 18 }, entry)).height).toBe(
      20 * 18,
    );
  });

  it('estimates a file with no counts, and a binary or text-less change', () => {
    const unknown = estimatePlaceholderHeight(entryOf({ kind: 'untracked', status: '?' }));
    expect(unknown).toBeGreaterThan(estimatePlaceholderHeight(entryOf({ added: 1, removed: 0 })));
    expect(estimatePlaceholderHeight(entryOf({ binary: true }))).toBe(DEFAULT_LINE_HEIGHT);
    expect(estimatePlaceholderHeight(entryOf({ added: 0, removed: 0 }))).toBe(DEFAULT_LINE_HEIGHT);
  });

  it('holds a measured height instead of the estimate', () => {
    const entry = entryOf({ added: 10, removed: 4 });
    expect(placeholder(build(undefined, 'unified', { placeholderHeight: 777 }, entry)).height).toBe(
      777,
    );
  });

  // The row of a binary or mode-only file is one line tall, and the message and
  // Retry button of a failed fetch are taller than that: drawn in it they overlap the
  // next file's header.
  it('holds a failed fetch’s message and Retry button, however short its estimate', () => {
    const small = entryOf({ binary: true });
    expect(placeholder(build(undefined, 'unified', {}, small)).height).toBe(DEFAULT_LINE_HEIGHT);
    expect(placeholder(build(undefined, 'unified', { failed: true }, small)).height).toBe(
      ERROR_ROW_HEIGHT,
    );
  });

  it('keeps the taller of the estimate, a measured height and the error height', () => {
    const big = entryOf({ added: 10, removed: 4 });
    expect(placeholder(build(undefined, 'unified', { failed: true }, big)).height).toBe(
      (14 + 6) * DEFAULT_LINE_HEIGHT,
    );
    expect(
      placeholder(build(undefined, 'unified', { failed: true, placeholderHeight: 5 }, big)).height,
    ).toBe(ERROR_ROW_HEIGHT);
  });

  it('is not drawn for a conflicted file, whose notice is final', () => {
    const rows = build(undefined, 'unified', {}, entryOf({ kind: 'unmerged', status: 'U' }));
    expect(rows.map((r) => r.type)).toEqual(['fileHeader', 'notice']);
    expect(must(ofType(rows, 'notice')[0]).notice).toBe('unmerged');
  });
});

// ── notices ───────────────────────────────────────────────────────────────────

describe('notices', () => {
  const notices = (rows: Row[]): NoticeRow[] => ofType(rows, 'notice');
  const kinds = (rows: Row[]) => notices(rows).map((n) => n.notice);

  it('says a binary file is binary and draws no lines', () => {
    const rows = build(snapshotOf(numbered(3), numbered(4), { binary: true }));
    expect(kinds(rows)).toEqual(['binary']);
    expect(rows.map((r) => r.type)).toEqual(['fileHeader', 'notice']);
  });

  it('says a file over the size limit is too large and draws no lines', () => {
    const rows = build(snapshotOf([], [], { tooLarge: true }));
    expect(kinds(rows)).toEqual(['tooLarge']);
    expect(rows).toHaveLength(2);
  });

  it('says a converted file cannot be shown', () => {
    const rows = build(snapshotOf([], [], { converted: true }));
    expect(kinds(rows)).toEqual(['converted']);
    expect(must(notices(rows)[0]).text).toMatch(/converted by git/);
  });

  it('explains a conflict from the snapshot or from the status entry', () => {
    const fromSnapshot = build(snapshotOf([], [], { unmerged: true }));
    expect(kinds(fromSnapshot)).toEqual(['unmerged']);
    expect(must(notices(fromSnapshot)[0]).text).toMatch(/Resolve them in your editor/);
    const fromEntry = build(
      snapshotOf([], []),
      'unified',
      {},
      entryOf({ kind: 'unmerged', status: 'U' }),
    );
    expect(kinds(fromEntry)).toEqual(['unmerged']);
  });

  it('shows one blocking reason, the most specific', () => {
    const snapshot = snapshotOf([], [], { binary: true, tooLarge: true, converted: true });
    expect(kinds(build(snapshot))).toEqual(['converted']);
    expect(kinds(build(snapshotOf([], [], { binary: true, tooLarge: true })))).toEqual(['binary']);
  });

  it('names a rename and still shows its content change', () => {
    const { before, after } = editAt(5, 20);
    const entry = entryOf({ path: 'src/b.ts', oldPath: 'src/a.ts', kind: 'rename', status: 'R' });
    const rows = build(
      snapshotOf(before, after, { path: 'src/b.ts', oldPath: 'src/a.ts' }),
      'unified',
      {},
      entry,
    );
    expect(kinds(rows)).toEqual(['rename']);
    expect(must(notices(rows)[0]).text).toBe('Renamed from src/a.ts');
    expect(ofType(rows, 'line').filter((l) => l.kind !== 'ctx')).toHaveLength(2);
    expect(rows[0]).toMatchObject({ oldPath: 'src/a.ts' });
  });

  it('shows a pure rename with a notice and no lines', () => {
    const lines = numbered(5);
    const entry = entryOf({ path: 'b.ts', oldPath: 'a.ts', kind: 'rename', status: 'R' });
    const rows = build(
      snapshotOf(lines, lines, { path: 'b.ts', oldPath: 'a.ts' }),
      'unified',
      {},
      entry,
    );
    expect(rows.map((r) => r.type)).toEqual(['fileHeader', 'notice']);
  });

  it('does not call a same-path entry a rename', () => {
    const { before, after } = editAt(5, 20);
    expect(kinds(build(snapshotOf(before, after, { oldPath: 'src/a.ts' })))).toEqual([]);
  });

  it('shows a mode change when only the executable bit changed', () => {
    const lines = numbered(3);
    const rows = build(snapshotOf(lines, lines, { modes: { old: '100644', new: '100755' } }));
    expect(kinds(rows)).toEqual(['mode']);
    expect(must(notices(rows)[0]).text).toBe('Mode changed from 100644 to 100755');
  });

  it('shows no mode change for a new or deleted file, or for equal modes', () => {
    expect(kinds(build(snapshotOf([], numbered(2), { modes: { new: '100644' } })))).toEqual([]);
    const lines = numbered(3);
    expect(
      kinds(build(snapshotOf(lines, lines, { modes: { old: '100644', new: '100644' } }))),
    ).toEqual([]);
  });

  describe('symlinks', () => {
    const link = (
      over: Partial<ScmFileSnapshot>,
      oldTarget: string[],
      newTarget: string[],
    ): NoticeRow[] => notices(build(snapshotOf(oldTarget, newTarget, over)));

    it('names a symbolic link whose target changed, and shows the target diff', () => {
      const snapshot = snapshotOf(['old/target'], ['new/target'], {
        symlink: { old: true, new: true },
        modes: { old: '120000', new: '120000' },
      });
      const rows = build(snapshot);
      expect(notices(rows).map((n) => [n.notice, n.text])).toEqual([['symlink', 'Symbolic link.']]);
      expect(ofType(rows, 'line').filter((l) => l.kind !== 'ctx')).toHaveLength(2);
    });

    it('names a new link and a deleted link', () => {
      expect(link({ symlink: { new: true } }, [], ['t'])).toMatchObject([
        { text: 'Symbolic link.' },
      ]);
      expect(link({ symlink: { old: true } }, ['t'], [])).toMatchObject([
        { text: 'Symbolic link.' },
      ]);
    });

    it('names a file that became a link, and a link that became a file', () => {
      const becameLink = link(
        { symlink: { old: false, new: true }, modes: { old: '100644', new: '120000' } },
        ['text'],
        ['target'],
      );
      expect(becameLink.map((n) => [n.notice, n.text])).toEqual([
        ['symlink', 'Became a symbolic link.'],
      ]);
      const stoppedBeingLink = link(
        { symlink: { old: true, new: false }, modes: { old: '120000', new: '100644' } },
        ['target'],
        ['text'],
      );
      expect(stoppedBeingLink.map((n) => n.text)).toEqual(['No longer a symbolic link.']);
    });
  });

  it('keeps notices above the lines, in a stable order', () => {
    const { before, after } = editAt(5, 20);
    const entry = entryOf({ path: 'b.ts', oldPath: 'a.ts', kind: 'rename', status: 'R' });
    const rows = build(
      snapshotOf(before, after, {
        path: 'b.ts',
        oldPath: 'a.ts',
        modes: { old: '100644', new: '100755' },
      }),
      'unified',
      {},
      entry,
    );
    expect(rows.map((r) => r.type).slice(0, 4)).toEqual(['fileHeader', 'notice', 'notice', 'gap']);
    expect(ofType(rows, 'notice').map((n) => n.notice)).toEqual(['rename', 'mode']);
  });
});

// ── lines: unified ────────────────────────────────────────────────────────────

describe('unified rows', () => {
  it('draws a hunk header and the hunk lines with old and new numbers', () => {
    const before = ['a', 'b', 'c', 'd'];
    const after = ['a', 'b', 'C', 'd'];
    const rows = build(snapshotOf(before, after));
    expect(rows.map((r) => r.type)).toEqual([
      'fileHeader',
      'hunkHeader',
      'line',
      'line',
      'line',
      'line',
      'line',
    ]);
    expect(must(ofType(rows, 'hunkHeader')[0]).header).toBe('@@ -1,4 +1,4 @@');
    // The range is built from the hunk's own numbers, for a server that sends only the
    // context after the second `@@`.
    expect(must(ofType(rows, 'hunkHeader')[0]).range).toBe('@@ -1,4 +1,4 @@');
    const lines = ofType(rows, 'line');
    expect(lines.map((l) => [l.kind, l.old, l.new, l.text])).toEqual([
      ['ctx', 1, 1, 'a'],
      ['ctx', 2, 2, 'b'],
      ['del', 3, undefined, 'c'],
      ['add', undefined, 3, 'C'],
      ['ctx', 4, 4, 'd'],
    ]);
  });

  it('puts each line on the side whose text it shows', () => {
    const rows = build(snapshotOf(['a', 'b'], ['a', 'B']));
    const lines = ofType(rows, 'line');
    expect(lines.map((l) => [l.kind, l.side, l.no])).toEqual([
      ['ctx', 'new', 1],
      ['del', 'old', 2],
      ['add', 'new', 2],
    ]);
  });

  it('pairs the i-th deletion with the i-th addition inside a change block', () => {
    const rows = build(snapshotOf(['x', 'a1', 'a2', 'y'], ['x', 'b1', 'b2', 'b3', 'y']));
    const mates = ofType(rows, 'line').map((l) => [l.text, l.mate]);
    expect(mates).toEqual([
      ['x', undefined],
      ['a1', 'b1'],
      ['a2', 'b2'],
      ['b1', 'a1'],
      ['b2', 'a2'],
      ['b3', undefined],
      ['y', undefined],
    ]);
  });

  it('pairs blocks separately, never across a context line', () => {
    const rows = build(snapshotOf(['a', 'k', 'b'], ['A', 'k', 'B']));
    const lines = ofType(rows, 'line');
    expect(lines.filter((l) => l.mate !== undefined).map((l) => [l.text, l.mate])).toEqual([
      ['a', 'A'],
      ['A', 'a'],
      ['b', 'B'],
      ['B', 'b'],
    ]);
  });

  it('carries a missing final newline', () => {
    const snapshot = snapshotOf(['a'], ['b']);
    must(snapshot.hunks[0]).lines.forEach((line) => {
      line.noEol = true;
    });
    const rows = build(snapshot);
    expect(ofType(rows, 'line').every((l) => l.noEol)).toBe(true);
  });

  it('uses unique keys across a whole review list', () => {
    const { before, after } = editAt(10, 200);
    const second = editAt(10, 200);
    const one = build(snapshotOf(before, after));
    const two = buildFileRows(
      {
        entry: entryOf({ path: 'src/b.ts' }),
        snapshot: snapshotOf(second.before, second.after, { path: 'src/b.ts' }),
      },
      { layout: 'unified' },
    );
    const keys = [...one, ...two].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const shape = (row: SplitRow) => [row.left?.text, row.right?.text, row.paired];

// ── lines: split ──────────────────────────────────────────────────────────────

describe('split rows', () => {
  const splits = (rows: Row[]): SplitRow[] => ofType(rows, 'split');

  it('pairs one deletion with one addition on one row', () => {
    const rows = splits(build(snapshotOf(['a', 'b', 'c'], ['a', 'B', 'c']), 'split'));
    expect(rows.map(shape)).toEqual([
      ['a', 'a', false],
      ['b', 'B', true],
      ['c', 'c', false],
    ]);
  });

  it('pairs the i-th deletion with the i-th addition and leaves the rest alone', () => {
    const rows = splits(
      build(snapshotOf(['x', 'a1', 'a2', 'y'], ['x', 'b1', 'b2', 'b3', 'y']), 'split'),
    );
    expect(rows.map(shape)).toEqual([
      ['x', 'x', false],
      ['a1', 'b1', true],
      ['a2', 'b2', true],
      [undefined, 'b3', false],
      ['y', 'y', false],
    ]);
  });

  it('leaves surplus deletions alone on the left', () => {
    const rows = splits(build(snapshotOf(['x', 'a1', 'a2', 'a3', 'y'], ['x', 'b1', 'y']), 'split'));
    expect(rows.map(shape)).toEqual([
      ['x', 'x', false],
      ['a1', 'b1', true],
      ['a2', undefined, false],
      ['a3', undefined, false],
      ['y', 'y', false],
    ]);
  });

  it('shows a pure deletion on the left and a pure addition on the right', () => {
    const deleted = splits(build(snapshotOf(['a', 'b'], ['a']), 'split'));
    expect(deleted.map(shape)).toEqual([
      ['a', 'a', false],
      ['b', undefined, false],
    ]);
    const added = splits(build(snapshotOf(['a'], ['a', 'b']), 'split'));
    expect(added.map(shape)).toEqual([
      ['a', 'a', false],
      [undefined, 'b', false],
    ]);
  });

  it('keeps each side numbered on its own', () => {
    const rows = splits(build(snapshotOf(['a', 'b1', 'b2', 'c'], ['a', 'B', 'c']), 'split'));
    expect(rows.map((r) => [r.left?.side, r.left?.no, r.right?.side, r.right?.no])).toEqual([
      ['old', 1, 'new', 1],
      ['old', 2, 'new', 2],
      ['old', 3, undefined, undefined],
      ['old', 4, 'new', 3],
    ]);
  });

  it('marks cell kinds', () => {
    const rows = splits(build(snapshotOf(['a', 'b'], ['a', 'B']), 'split'));
    expect(rows.map((r) => [r.left?.kind, r.right?.kind])).toEqual([
      ['ctx', 'ctx'],
      ['del', 'add'],
    ]);
  });

  it('pairs each change block on its own', () => {
    const rows = splits(build(snapshotOf(['a', 'k', 'b'], ['A', 'k', 'B']), 'split'));
    expect(rows.map(shape)).toEqual([
      ['a', 'A', true],
      ['k', 'k', false],
      ['b', 'B', true],
    ]);
  });

  it('pairs an interleaved block as git groups it: all deletions, then all additions', () => {
    const snapshot = snapshotOf(['a', 'b'], ['A', 'B']);
    const lines = must(snapshot.hunks[0]).lines;
    // A hand-built hunk with the kinds interleaved; the pairing still takes the i-th of each kind.
    snapshot.hunks = [
      {
        ...must(snapshot.hunks[0]),
        lines: [
          must(lines.find((l) => l.text === 'a')),
          must(lines.find((l) => l.text === 'A')),
          must(lines.find((l) => l.text === 'b')),
          must(lines.find((l) => l.text === 'B')),
        ],
      },
    ];
    expect(splits(build(snapshot, 'split')).map(shape)).toEqual([
      ['a', 'A', true],
      ['b', 'B', true],
    ]);
  });
});

// ── gaps ──────────────────────────────────────────────────────────────────────

describe('gaps', () => {
  it('offers hidden lines before the first hunk and after the last', () => {
    const { before, after } = editAt(50);
    const rows = build(snapshotOf(before, after));
    expect(
      gaps(rows).map((g) => [g.position, g.gapIndex, g.size, g.hidden, g.canUp, g.canDown]),
    ).toEqual([
      ['start', 0, 46, 46, true, false],
      ['end', 1, 47, 47, false, true],
    ]);
  });

  it('puts the gap rows before the first hunk header and after the last line', () => {
    const { before, after } = editAt(50);
    const types = build(snapshotOf(before, after)).map((r) => r.type);
    expect(types[1]).toBe('gap');
    expect(types[2]).toBe('hunkHeader');
    expect(types[types.length - 1]).toBe('gap');
  });

  it('offers hidden lines between two hunks', () => {
    const before = numbered(100);
    const after = before.map((t, i) => (i === 9 || i === 89 ? `${t} edited` : t));
    const rows = build(snapshotOf(before, after));
    const between = must(gaps(rows).find((g) => g.position === 'between'));
    // Hunk one ends at line 13 and hunk two starts at 87: 73 hidden lines.
    expect(between).toMatchObject({
      gapIndex: 1,
      size: 73,
      hidden: 73,
      canUp: true,
      canDown: true,
    });
  });

  it('draws no gap when the hunks touch the file edges', () => {
    const rows = build(snapshotOf(numbered(4), ['x', ...numbered(4).slice(1)]));
    expect(gaps(rows)).toEqual([]);
  });

  it('draws no gap for a new file or a deleted file', () => {
    expect(gaps(build(snapshotOf([], numbered(30))))).toEqual([]);
    expect(gaps(build(snapshotOf(numbered(30), [])))).toEqual([]);
  });

  it('draws no gap and no hunk for a file with no content change', () => {
    const lines = numbered(30);
    const rows = build(snapshotOf(lines, lines, { modes: { old: '100644', new: '100755' } }));
    expect(rows.map((r) => r.type)).toEqual(['fileHeader', 'notice']);
  });

  it('draws the same gaps in split layout', () => {
    const { before, after } = editAt(50);
    const unified = gaps(build(snapshotOf(before, after)));
    const split = gaps(build(snapshotOf(before, after), 'split'));
    expect(split).toEqual(unified);
  });

  describe('expansion', () => {
    // 200 lines, edits at 10 and 97: an 80-line gap between the hunks (14..93).
    const before = numbered(200);
    const after = before.map((t, i) => (i === 9 || i === 96 ? `${t} edited` : t));
    const snapshot = snapshotOf(before, after);
    const between = (rows: Row[]) => must(gaps(rows).find((g) => g.position === 'between'));
    const withReveals = (reveals: GapReveals, layout: RowsLayout = 'unified') =>
      build(snapshot, layout, { reveals });

    it('starts with 80 hidden lines', () => {
      expect(between(withReveals({}))).toMatchObject({ size: 80, hidden: 80 });
    });

    it('reveals a step at a time with correct numbers', () => {
      let reveals: GapReveals = {};
      let rows = withReveals(reveals);
      const gapRowOf = () => between(rows);

      reveals = expandGap(reveals, gapRowOf(), 'down');
      rows = withReveals(reveals);
      expect(gapRowOf().hidden).toBe(60);
      let revealed = ofType(rows, 'line').filter(
        (l) => l.text === 'line 14' || l.text === 'line 33',
      );
      expect(revealed.map((l) => [l.text, l.old, l.new])).toEqual([
        ['line 14', 14, 14],
        ['line 33', 33, 33],
      ]);
      expect(ofType(rows, 'line').some((l) => l.text === 'line 34')).toBe(false);

      reveals = expandGap(reveals, gapRowOf(), 'up');
      rows = withReveals(reveals);
      expect(gapRowOf().hidden).toBe(40);
      revealed = ofType(rows, 'line').filter((l) => l.text === 'line 74' || l.text === 'line 93');
      expect(revealed.map((l) => [l.text, l.old, l.new])).toEqual([
        ['line 74', 74, 74],
        ['line 93', 93, 93],
      ]);

      reveals = expandGap(reveals, gapRowOf(), 'down');
      reveals = expandGap(reveals, gapRowOf(), 'down');
      rows = withReveals(reveals);
      expect(gaps(rows).filter((g) => g.position === 'between')).toEqual([]);
    });

    it('lays the rows out as revealed-below, the gap, the hunk header, revealed-above', () => {
      const first = between(withReveals({}));
      const reveals = expandGap(expandGap({}, first, 'down'), first, 'up');
      const rows = withReveals(reveals);
      const index = rows.findIndex((r) => r.type === 'gap' && r.gapIndex === 1);
      const around = rows
        .slice(index - 2, index + 4)
        .map((r) => (r.type === 'line' ? r.text : r.type));
      expect(around).toEqual(['line 32', 'line 33', 'gap', 'hunkHeader', 'line 74', 'line 75']);
    });

    it('reveals everything at once', () => {
      const reveals = expandGap({}, between(withReveals({})), 'all');
      const rows = withReveals(reveals);
      expect(gaps(rows).filter((g) => g.position === 'between')).toEqual([]);
      const texts = ofType(rows, 'line').map((l) => l.text);
      expect(texts).toContain('line 14');
      expect(texts).toContain('line 93');
    });

    it('never reveals more than the gap holds', () => {
      const gap = between(withReveals({}));
      let reveals: GapReveals = {};
      for (let i = 0; i < 10; i++) reveals = expandGap(reveals, gap, 'down');
      expect(reveals[gap.gapIndex]).toEqual({ fromPrev: 80, fromNext: 0 });
      reveals = expandGap(reveals, gap, 'up');
      expect(reveals[gap.gapIndex]).toEqual({ fromPrev: 80, fromNext: 0 });
    });

    it('expands the leading gap upward only and the trailing gap downward only', () => {
      const rows = withReveals({});
      const start = must(gaps(rows).find((g) => g.position === 'start'));
      const end = must(gaps(rows).find((g) => g.position === 'end'));
      const same: GapReveals = {};
      expect(expandGap(same, start, 'down')).toBe(same);
      expect(expandGap(same, end, 'up')).toBe(same);

      // The leading gap is lines 1-6, so one step up reveals all of it.
      expect(start.size).toBe(6);
      const upRows = withReveals(expandGap(same, start, 'up'));
      expect(gaps(upRows).some((g) => g.position === 'start')).toBe(false);
      expect(ofType(upRows, 'line')[0]).toMatchObject({ text: 'line 1', old: 1, new: 1 });

      // The trailing gap is lines 101-200: one step down reveals 20 and leaves 80.
      expect(end.size).toBe(100);
      const downRows = withReveals(expandGap(same, end, 'down'));
      expect(must(gaps(downRows).find((g) => g.position === 'end')).hidden).toBe(
        end.size - GAP_STEP,
      );
      const firstRevealed = must(ofType(downRows, 'line').find((l) => l.text === 'line 101'));
      expect([firstRevealed.old, firstRevealed.new]).toEqual([101, 101]);
    });

    it('reveals the whole leading and trailing gap with all', () => {
      const rows = withReveals({});
      const start = must(gaps(rows).find((g) => g.position === 'start'));
      const end = must(gaps(rows).find((g) => g.position === 'end'));
      const reveals = expandGap(expandGap({}, start, 'all'), end, 'all');
      const full = withReveals(reveals);
      expect(gaps(full).filter((g) => g.position !== 'between')).toEqual([]);
      expect(ofType(full, 'line')[0]).toMatchObject({ text: 'line 1', old: 1, new: 1 });
      const last = must(ofType(full, 'line').at(-1));
      expect(last).toMatchObject({ text: 'line 200', old: 200, new: 200 });
    });

    it('does not modify the reveals it is given', () => {
      const gap = between(withReveals({}));
      const reveals: GapReveals = Object.freeze({});
      const next = expandGap(reveals, gap, 'down');
      expect(reveals).toEqual({});
      expect(next).not.toBe(reveals);
    });

    it('numbers revealed lines on both sides when the file grew above them', () => {
      // Three lines are inserted in the first hunk, so new numbers run 3 ahead of old.
      const oldLines = numbered(200);
      const newLines = [
        ...oldLines.slice(0, 10),
        'ins 1',
        'ins 2',
        'ins 3',
        ...oldLines.slice(10, 96),
        'edited',
        ...oldLines.slice(97),
      ];
      const shifted = snapshotOf(oldLines, newLines);
      const rows = build(shifted);
      const gap = must(gaps(rows).find((g) => g.position === 'between'));
      const revealed = build(shifted, 'unified', { reveals: expandGap({}, gap, 'down') });
      const first = must(ofType(revealed, 'line').find((l) => l.text === 'line 14'));
      expect([first.old, first.new]).toEqual([14, 17]);
      const split = build(shifted, 'split', { reveals: expandGap({}, gap, 'down') });
      const cell = must(ofType(split, 'split').find((r) => r.left?.text === 'line 14'));
      expect([cell.left?.no, cell.right?.no]).toEqual([14, 17]);
    });

    it('numbers revealed lines when the file shrank above them', () => {
      const oldLines = numbered(200);
      const newLines = [
        ...oldLines.slice(0, 9),
        ...oldLines.slice(12, 96),
        'edited',
        ...oldLines.slice(97),
      ];
      const shifted = snapshotOf(oldLines, newLines);
      const gap = must(gaps(build(shifted)).find((g) => g.position === 'between'));
      const revealed = build(shifted, 'unified', { reveals: expandGap({}, gap, 'up') });
      const row = must(ofType(revealed, 'line').find((l) => l.text === 'line 96'));
      expect([row.old, row.new]).toEqual([96, 93]);
    });

    it('marks a revealed last line that has no final newline', () => {
      const lines = numbered(30);
      const changed = lines.map((t, i) => (i === 0 ? 'first edited' : t));
      const unterminated = snapshotOf(lines, changed);
      unterminated.old.text = unterminated.old.text.slice(0, -1);
      unterminated.new.text = unterminated.new.text.slice(0, -1);
      const gap = must(gaps(build(unterminated)).find((g) => g.position === 'end'));
      const rows = build(unterminated, 'unified', { reveals: expandGap({}, gap, 'all') });
      const last = must(ofType(rows, 'line').at(-1));
      expect([last.text, last.noEol]).toEqual(['line 30', true]);
      expect(must(ofType(rows, 'line').find((l) => l.text === 'line 29')).noEol).toBe(false);
    });
  });
});

// ── an invariant over random edits ────────────────────────────────────────────

/** A small deterministic generator, so a failure names the seed that reproduces it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEdit(seed: number): { before: string[]; after: string[] } {
  const next = random(seed);
  // A small alphabet makes repeated lines (`}`, blanks) common, which is where numbering goes wrong.
  const alphabet = ['', '}', '{', 'a', 'b', 'return x;', 'if (y) {'];
  const pick = (): string => must(alphabet[Math.floor(next() * alphabet.length)]);
  const before = Array.from({ length: Math.floor(next() * 60) }, pick);
  const after = [...before];
  for (let edits = Math.floor(next() * 6); edits > 0; edits--) {
    const at = Math.floor(next() * (after.length + 1));
    const roll = next();
    if (roll < 0.35)
      after.splice(at, 0, ...Array.from({ length: 1 + Math.floor(next() * 3) }, pick));
    else if (roll < 0.7) after.splice(at, 1 + Math.floor(next() * 3));
    else after.splice(at, 1, pick());
  }
  return { before, after };
}

const changed = (before: readonly string[], after: readonly string[]): boolean =>
  before.length !== after.length || before.some((line, i) => line !== after[i]);

function revealAll(snapshot: ScmFileSnapshot, layout: RowsLayout): Row[] {
  let reveals: GapReveals = {};
  for (;;) {
    const rows = build(snapshot, layout, { reveals });
    const gap = gaps(rows)[0];
    if (!gap) return rows;
    reveals = expandGap(reveals, gap, 'all');
  }
}

describe('rows over random edits', () => {
  const seeds = Array.from({ length: 150 }, (_, i) => i + 1);

  it('exercises real changes, including files with several hunks', () => {
    const hunkCounts = seeds.map((seed) => {
      const { before, after } = randomEdit(seed);
      return snapshotOf(before, after).hunks.length;
    });
    expect(hunkCounts.filter((n) => n >= 1).length).toBeGreaterThan(100);
    expect(hunkCounts.filter((n) => n >= 2).length).toBeGreaterThan(20);
  });

  it('reproduces both files exactly, unified, once every gap is expanded', () => {
    for (const seed of seeds) {
      const { before, after } = randomEdit(seed);
      const rows = ofType(revealAll(snapshotOf(before, after), 'unified'), 'line');
      // With no change there are no hunks, and a file with no hunks shows no lines.
      if (!changed(before, after)) {
        expect(rows, `seed ${seed}`).toEqual([]);
        continue;
      }
      const oldSide = rows.filter((l) => l.kind !== 'add');
      const newSide = rows.filter((l) => l.kind !== 'del');
      expect(
        oldSide.map((l) => l.text),
        `seed ${seed}`,
      ).toEqual(before);
      expect(
        newSide.map((l) => l.text),
        `seed ${seed}`,
      ).toEqual(after);
      expect(
        oldSide.map((l) => l.old),
        `seed ${seed}`,
      ).toEqual(before.map((_, i) => i + 1));
      expect(
        newSide.map((l) => l.new),
        `seed ${seed}`,
      ).toEqual(after.map((_, i) => i + 1));
    }
  });

  it('reproduces both files exactly, split, once every gap is expanded', () => {
    for (const seed of seeds) {
      const { before, after } = randomEdit(seed);
      const rows = ofType(revealAll(snapshotOf(before, after), 'split'), 'split');
      if (!changed(before, after)) {
        expect(rows, `seed ${seed}`).toEqual([]);
        continue;
      }
      const left = rows.flatMap((r) => (r.left ? [r.left] : []));
      const right = rows.flatMap((r) => (r.right ? [r.right] : []));
      expect(
        left.map((c) => c.text),
        `seed ${seed}`,
      ).toEqual(before);
      expect(
        right.map((c) => c.text),
        `seed ${seed}`,
      ).toEqual(after);
      expect(
        left.map((c) => c.no),
        `seed ${seed}`,
      ).toEqual(before.map((_, i) => i + 1));
      expect(
        right.map((c) => c.no),
        `seed ${seed}`,
      ).toEqual(after.map((_, i) => i + 1));
    }
  });

  it('keeps every unchanged row consistent with both files after partial expansion', () => {
    for (const seed of seeds) {
      const { before, after } = randomEdit(seed);
      const snapshot = snapshotOf(before, after);
      const pick = random(seed * 7919);
      let reveals: GapReveals = {};
      for (let step = 0; step < 6; step++) {
        const gap = gaps(build(snapshot, 'unified', { reveals }))[0];
        if (!gap) break;
        const directions = ['up', 'down', 'all'] as const;
        reveals = expandGap(reveals, gap, must(directions[Math.floor(pick() * 3)]));
        const rows = ofType(build(snapshot, 'unified', { reveals }), 'line');
        for (const row of rows.filter((l) => l.kind === 'ctx')) {
          expect(before[must(row.old) - 1], `seed ${seed}`).toBe(row.text);
          expect(after[must(row.new) - 1], `seed ${seed}`).toBe(row.text);
        }
        const newNumbers = rows.filter((l) => l.kind !== 'del').map((l) => must(l.new));
        expect(newNumbers, `seed ${seed}`).toEqual([...newNumbers].toSorted((a, b) => a - b));
        expect(new Set(newNumbers).size, `seed ${seed}`).toBe(newNumbers.length);
      }
    }
  });
});

// ── rowLine ───────────────────────────────────────────────────────────────────

describe('rowLine', () => {
  it('names the side, number and text of a unified line', () => {
    const rows = build(snapshotOf(['a', 'b'], ['a', 'B']));
    const lines = ofType(rows, 'line');
    expect(rowLine(must(lines[1]))).toEqual({ side: 'old', no: 2, text: 'b' });
    expect(rowLine(must(lines[2]))).toEqual({ side: 'new', no: 2, text: 'B' });
  });

  it('prefers the new side of a split row, and falls back to the old', () => {
    const rows = ofType(build(snapshotOf(['a', 'b', 'c'], ['a', 'B']), 'split'), 'split');
    expect(rowLine(must(rows[1]))).toEqual({ side: 'new', no: 2, text: 'B' });
    expect(rowLine(must(rows[2]))).toEqual({ side: 'old', no: 3, text: 'c' });
  });

  it('is null for rows that are not lines', () => {
    const rows = build(snapshotOf(['a'], ['b']));
    for (const row of rows.filter((r) => r.type !== 'line')) expect(rowLine(row)).toBeNull();
  });
});

describe('splitLines in the rows model', () => {
  it('agrees with the text the snapshot fixtures carry', () => {
    expect(splitLines(textOf(['a', '', 'b']))).toEqual(['a', '', 'b']);
  });
});
