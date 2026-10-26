// Where each comment is drawn: under the last line of its range, on the side of the
// open review it was found on; the unsaved editor under the lines it is for; and
// the comments that cannot hang from a line, in one list at the end of the file.

import { describe, expect, it } from 'vitest';
import type { ScmComment, ScmEntry, ScmFileSnapshot, ScmHunk, ScmHunkLine } from '@palmux/shared';
import { hasNotes, withNotes, type FileNotes } from './annotations';
import type { PlacedComment } from './comment-placement';
import { buildFileRows, type Row, type RowsLayout } from './rows';

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

const entry: ScmEntry = {
  path: 'a.ts',
  kind: 'ordinary',
  status: 'M',
  fp: 'fp',
  added: 2,
  removed: 1,
};
const snapshot: ScmFileSnapshot = {
  path: 'a.ts',
  group: 'changes',
  algorithm: 'histogram',
  old: { id: 'o', text: 'one\ntwo\nthree\n' },
  new: { id: 'n', text: 'one\nTWO\nthree\nfour\n' },
  hunks: [
    hunk([
      ['ctx', 'one'],
      ['del', 'two'],
      ['add', 'TWO'],
      ['ctx', 'three'],
      ['add', 'four'],
    ]),
  ],
  binary: false,
  tooLarge: false,
  converted: false,
  unmerged: false,
  modes: {},
  attrs: {},
  version: 'v1',
};

const comment = (id: string, over: Partial<ScmComment> = {}): ScmComment => ({
  id,
  path: 'a.ts',
  version: 'worktree',
  side: 'new',
  start: 2,
  end: 2,
  lines: ['TWO'],
  before: ['one'],
  after: ['three', 'four'],
  body: `note ${id}`,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const placed = (c: ScmComment, over: Partial<PlacedComment> = {}): PlacedComment => ({
  comment: c,
  side: c.side,
  start: c.start,
  end: c.end,
  ...over,
});

const notes = (over: Partial<FileNotes> = {}): FileNotes => ({
  placed: [],
  outdated: [],
  unread: [],
  drafts: [],
  ...over,
});

const rowsFor = (layout: RowsLayout): readonly Row[] =>
  buildFileRows({ entry, snapshot }, { layout });

/** What is drawn after the row that shows `side` line `no`: the kinds of the rows that follow it. */
function after(rows: readonly Row[], side: 'old' | 'new', no: number): string[] {
  const at = rows.findIndex((row) => {
    if (row.type === 'line') return (side === 'old' ? row.old : row.new) === no;
    if (row.type === 'split') return (side === 'old' ? row.left : row.right)?.no === no;
    return false;
  });
  const out: string[] = [];
  for (let i = at + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row?.type !== 'comment' && row?.type !== 'editor') break;
    out.push(row.type);
  }
  return out;
}

describe('a comment under the last line of its range', () => {
  it('is drawn right after the row of that line, in unified', () => {
    const c = comment('c1');
    const out = withNotes('a.ts', rowsFor('unified'), notes({ placed: [placed(c)] }));
    expect(after(out, 'new', 2)).toEqual(['comment']);
    const row = out.find((r) => r.type === 'comment');
    expect(row).toMatchObject({ key: 'a.ts|comment:c1', side: 'new', start: 2, end: 2 });
  });

  it('goes under the LAST line of a range, not the first', () => {
    const c = comment('c1', { start: 2, end: 3, lines: ['TWO', 'three'], after: ['four'] });
    const out = withNotes('a.ts', rowsFor('unified'), notes({ placed: [placed(c)] }));
    expect(after(out, 'new', 2)).toEqual([]);
    expect(after(out, 'new', 3)).toEqual(['comment']);
  });

  it('is drawn on the side it was found on: an old-side comment sits under the removed line', () => {
    const c = comment('c1', { side: 'old', version: 'index', start: 2, end: 2, lines: ['two'] });
    const out = withNotes('a.ts', rowsFor('unified'), notes({ placed: [placed(c)] }));
    expect(after(out, 'old', 2)).toEqual(['comment']);
    // The new-side line 2 is the added TWO, a different row.
    expect(after(out, 'new', 2)).toEqual([]);
  });

  it('is drawn on the side the review found it, which need not be the side it was made on', () => {
    // Made on the old side; Staged shows the same code on its new side now.
    const c = comment('c1', { side: 'old', version: 'worktree' });
    const out = withNotes(
      'a.ts',
      rowsFor('unified'),
      notes({ placed: [placed(c, { side: 'new' })] }),
    );
    expect(after(out, 'new', 2)).toEqual(['comment']);
    expect(out.find((r) => r.type === 'comment')).toMatchObject({ side: 'new' });
  });

  it('is drawn under the split row of its line', () => {
    const c = comment('c1');
    const out = withNotes('a.ts', rowsFor('split'), notes({ placed: [placed(c)] }));
    expect(after(out, 'new', 2)).toEqual(['comment']);
  });

  it('orders several on one line as they were made', () => {
    const late = comment('late', { createdAt: 5 });
    const early = comment('early', { createdAt: 2 });
    const out = withNotes(
      'a.ts',
      rowsFor('unified'),
      notes({ placed: [placed(late), placed(early)] }),
    );
    expect(out.filter((r) => r.type === 'comment').map((r) => r.key)).toEqual([
      'a.ts|comment:early',
      'a.ts|comment:late',
    ]);
  });

  it('adds rows and removes none', () => {
    const rows = rowsFor('unified');
    const out = withNotes('a.ts', rows, notes({ placed: [placed(comment('c1'))] }));
    expect(out).toHaveLength(rows.length + 1);
    expect(out.filter((r) => r.type !== 'comment')).toEqual(rows);
  });

  it('returns the very same rows when there is nothing to draw', () => {
    const rows = rowsFor('unified');
    expect(hasNotes(notes())).toBe(false);
    expect(withNotes('a.ts', rows, notes())).toBe(rows);
  });
});

describe('the editor of a comment being written', () => {
  const draft = { path: 'a.ts', side: 'new', start: 2, end: 2 } as const;

  it('is drawn under the lines it is for, after any comment already there', () => {
    const c = comment('c1');
    const out = withNotes(
      'a.ts',
      rowsFor('unified'),
      notes({ placed: [placed(c)], drafts: [draft] }),
    );
    expect(after(out, 'new', 2)).toEqual(['comment', 'editor']);
    expect(out.find((r) => r.type === 'editor')).toMatchObject({
      key: expect.stringContaining('a.ts|editor:'),
      target: draft,
      comment: undefined,
    });
  });

  it('goes to the end of the file when its lines are not drawn any more', () => {
    const out = withNotes(
      'a.ts',
      rowsFor('unified'),
      notes({ drafts: [{ ...draft, start: 99, end: 99 }] }),
    );
    expect(out.at(-1)?.type).toBe('editor');
  });
});

describe('the editor of an edit replaces the card it edits', () => {
  it('in place, under the same line, and the card is not drawn twice', () => {
    const c = comment('c1');
    const edit = { path: 'a.ts', side: 'new', start: 2, end: 2, commentId: 'c1' } as const;
    const out = withNotes(
      'a.ts',
      rowsFor('unified'),
      notes({ placed: [placed(c)], drafts: [edit] }),
    );
    expect(after(out, 'new', 2)).toEqual(['editor']);
    expect(out.some((r) => r.type === 'comment')).toBe(false);
    expect(out.find((r) => r.type === 'editor')).toMatchObject({ comment: c, target: edit });
  });

  it('keeps a new comment on the same lines apart from the edit', () => {
    const c = comment('c1');
    const edit = { path: 'a.ts', side: 'new', start: 2, end: 2, commentId: 'c1' } as const;
    const fresh = { path: 'a.ts', side: 'new', start: 2, end: 2 } as const;
    const out = withNotes(
      'a.ts',
      rowsFor('unified'),
      notes({ placed: [placed(c)], drafts: [edit, fresh] }),
    );
    expect(after(out, 'new', 2)).toEqual(['editor', 'editor']);
  });
});

describe('a comment with no line to hang from', () => {
  it('is listed at the end of the file when its code is gone, with the code it was about', () => {
    const gone = comment('gone', { lines: ['deleted line'], start: 40, end: 40 });
    const rows = rowsFor('unified');
    const out = withNotes('a.ts', rows, notes({ outdated: [gone] }));
    const list = out.at(-1);
    expect(list).toMatchObject({ type: 'unplaced', key: 'a.ts|unplaced' });
    if (list?.type !== 'unplaced') throw new Error('expected the list');
    expect(list.items).toEqual([{ comment: gone, reason: 'outdated', draft: undefined }]);
    expect(list.items[0]?.comment.lines).toEqual(['deleted line']);
    // And attached to no line.
    expect(out.slice(0, -1)).toEqual(rows);
  });

  it('is listed, as hidden, when it was found but its line sits in a gap that is not shown', () => {
    const hidden = comment('hidden', { start: 50, end: 50 });
    const out = withNotes('a.ts', rowsFor('unified'), notes({ placed: [placed(hidden)] }));
    const list = out.at(-1);
    if (list?.type !== 'unplaced') throw new Error('expected the list');
    expect(list.items).toMatchObject([{ reason: 'hidden' }]);
    expect(out.some((r) => r.type === 'comment')).toBe(false);
  });

  it('lists a hidden comment at the lines it was found at now, not the ones it was stored with', () => {
    // Stored at 3, found at 50 (lines went in above it); the gap hides 50.
    const moved = comment('moved', { start: 3, end: 3 });
    const found = placed(moved, { start: 50, end: 52 });
    const out = withNotes('a.ts', rowsFor('unified'), notes({ placed: [found] }));
    const list = out.at(-1);
    if (list?.type !== 'unplaced') throw new Error('expected the list');
    expect(list.items).toEqual([
      {
        comment: moved,
        reason: 'hidden',
        at: { side: 'new', start: 50, end: 52 },
        draft: undefined,
      },
    ]);
  });

  it('lists a comment on a file palmux did not read as unread, never as outdated', () => {
    const big = comment('big');
    const out = withNotes('a.ts', rowsFor('unified'), notes({ unread: [big] }));
    const list = out.at(-1);
    if (list?.type !== 'unplaced') throw new Error('expected the list');
    expect(list.items).toEqual([{ comment: big, reason: 'unread', draft: undefined }]);
  });

  it('draws unread comments and has notes even with nothing else to draw', () => {
    expect(hasNotes(notes({ unread: [comment('big')] }))).toBe(true);
  });

  it('carries the draft of an edit to an unread comment', () => {
    const big = comment('big');
    const edit = { path: 'a.ts', side: 'new', start: 2, end: 2, commentId: 'big' } as const;
    const out = withNotes('a.ts', rowsFor('unified'), notes({ unread: [big], drafts: [edit] }));
    const list = out.at(-1);
    if (list?.type !== 'unplaced') throw new Error('expected the list');
    expect(list.items[0]?.draft).toEqual(edit);
    expect(out.some((r) => r.type === 'editor')).toBe(false);
  });

  it('carries the draft of an edit to a comment that is in the list', () => {
    const gone = comment('gone', { lines: ['deleted line'], start: 40, end: 40 });
    const edit = { path: 'a.ts', side: 'new', start: 40, end: 40, commentId: 'gone' } as const;
    const out = withNotes('a.ts', rowsFor('unified'), notes({ outdated: [gone], drafts: [edit] }));
    const list = out.at(-1);
    if (list?.type !== 'unplaced') throw new Error('expected the list');
    expect(list.items[0]?.draft).toEqual(edit);
  });
});

describe('an edit whose comment is gone', () => {
  const orphan = { path: 'a.ts', side: 'new', start: 2, end: 2, commentId: 'deleted' } as const;

  it('is kept as an orphaned editor at the end of the file, never dropped', () => {
    const out = withNotes('a.ts', rowsFor('unified'), notes({ drafts: [orphan] }));
    const row = out.at(-1);
    expect(row).toMatchObject({
      type: 'editor',
      orphaned: true,
      target: orphan,
      comment: undefined,
      key: expect.stringContaining('a.ts|editor:'),
    });
    // Under no line: its comment, and so its place, is gone.
    expect(after(out, 'new', 2)).toEqual([]);
  });

  it('is not an orphan while its comment is placed, outdated or unread', () => {
    const kept = comment('deleted');
    for (const over of [{ placed: [placed(kept)] }, { outdated: [kept] }, { unread: [kept] }]) {
      const out = withNotes('a.ts', rowsFor('unified'), notes({ ...over, drafts: [orphan] }));
      expect(out.some((r) => r.type === 'editor' && r.orphaned === true)).toBe(false);
    }
  });

  it('is not raised by an unsaved NEW comment, which has no id to be gone', () => {
    const fresh = { path: 'a.ts', side: 'new', start: 2, end: 2 } as const;
    const out = withNotes('a.ts', rowsFor('unified'), notes({ drafts: [fresh] }));
    expect(out.some((r) => r.type === 'editor' && r.orphaned === true)).toBe(false);
  });
});
