// The scenario names follow the `review-comments` spec ("Comments stay attached to
// their code"). Every comment is made the way the review makes one: from the
// side's own lines, with `specAt`-style context, then the file changes under it.

import type {
  ScmComment,
  ScmCommentSide,
  ScmCommentVersion,
  ScmFileSnapshot,
} from '@palmux/shared';
import { describe, expect, it } from 'vitest';
import { splitLines } from './anchor';
import {
  captureRange,
  commentInput,
  isUnread,
  placeComments,
  placeInSnapshot,
  placementSidesOf,
  versionOf,
  type PlacementSides,
} from './comment-placement';

const lines = (text: string): string[] => splitLines(text);

/** A comment on `start..end` of `source`, with three lines of context either side, as stored. */
function commentOn(
  source: readonly string[],
  start: number,
  made: { side: ScmCommentSide; version: ScmCommentVersion },
  over: Partial<ScmComment> = {},
  end = start,
): ScmComment {
  return {
    id: `c-${made.side}-${start}-${end}`,
    path: 'a.ts',
    version: made.version,
    side: made.side,
    start,
    end,
    lines: source.slice(start - 1, end),
    before: source.slice(Math.max(0, start - 4), start - 1),
    after: source.slice(end, end + 3),
    body: 'note',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const file = lines(
  [
    'import a',
    'import b',
    '',
    'function f() {',
    '  one();',
    '  two();',
    '  three();',
    '}',
    '',
    'export {};',
  ].join('\n'),
);

const changes = (oldLines: string[], newLines: string[]): PlacementSides => ({
  old: { version: 'index', lines: oldLines },
  new: { version: 'worktree', lines: newLines },
});
const staged = (oldLines: string[], newLines: string[]): PlacementSides => ({
  old: { version: 'head', lines: oldLines },
  new: { version: 'index', lines: newLines },
});

describe('placeComments', () => {
  it('draws a comment on the side and lines it was made on', () => {
    const c = commentOn(file, 6, { side: 'new', version: 'worktree' });
    const { placed, outdated } = placeComments([c], changes(file, file));
    expect(outdated).toEqual([]);
    expect(placed).toEqual([{ comment: c, side: 'new', start: 6, end: 6 }]);
  });

  it('moves a comment to where its code now is when lines are inserted above', () => {
    const c = commentOn(file, 6, { side: 'new', version: 'worktree' });
    const inserted = [
      ...file.slice(0, 2),
      ...Array.from({ length: 10 }, (_, i) => `// ${i}`),
      ...file.slice(2),
    ];
    const { placed } = placeComments([c], changes(file, inserted));
    expect(placed).toEqual([{ comment: c, side: 'new', start: 16, end: 16 }]);
  });

  it('keeps a range together', () => {
    const c = commentOn(file, 5, { side: 'new', version: 'worktree' }, {}, 7);
    const { placed } = placeComments([c], changes(file, ['// new top', ...file]));
    expect(placed).toEqual([{ comment: c, side: 'new', start: 6, end: 8 }]);
  });

  describe('A comment survives Reviewed', () => {
    // Made on Changes' new side (the work tree), then Reviewed stages the file. The
    // staged file's new side is the index, which now holds those same lines.
    const worktree = file;
    const made = commentOn(worktree, 6, { side: 'new', version: 'worktree' });

    it('shows on the same line of the staged version when the lines are equal', () => {
      const headBefore = file.filter((line) => line !== '  two();');
      const { placed, outdated } = placeComments([made], staged(headBefore, worktree));
      expect(outdated).toEqual([]);
      expect(placed).toEqual([{ comment: made, side: 'new', start: 6, end: 6 }]);
    });

    it('does not guess when the staged version no longer holds the code', () => {
      const { placed, outdated } = placeComments(
        [made],
        staged(
          file.filter((line) => line !== '  two();'),
          file.filter((line) => line !== '  two();'),
        ),
      );
      expect(placed).toEqual([]);
      expect(outdated).toEqual([made]);
    });
  });

  it('prefers the side that shows the comment own version', () => {
    // The same lines are on both sides of Staged, so a comment made on the index
    // (Changes' old side) belongs to Staged's new side, whose version is the index.
    const c = commentOn(file, 5, { side: 'old', version: 'index' });
    const { placed } = placeComments([c], staged(file, file));
    expect(placed).toEqual([{ comment: c, side: 'new', start: 5, end: 5 }]);
  });

  it('prefers the old side for a comment made on the head', () => {
    const c = commentOn(file, 5, { side: 'old', version: 'head' });
    const { placed } = placeComments([c], staged(file, file));
    expect(placed).toEqual([{ comment: c, side: 'old', start: 5, end: 5 }]);
  });

  it('falls back to the side it was made on when neither side shows its version', () => {
    // A work-tree comment viewed in Staged: both sides hold the line, the comment's
    // own side decides.
    const onOld = commentOn(file, 5, { side: 'old', version: 'worktree' });
    const onNew = commentOn(file, 5, { side: 'new', version: 'worktree' });
    const { placed } = placeComments([onOld, onNew], staged(file, file));
    expect(placed.map((p) => p.side)).toEqual(['old', 'new']);
  });

  it('uses the other side when the preferred one no longer has the code', () => {
    // The line was removed from the work tree: a comment made on it under Changes'
    // new side now draws on the old side, where the deleted line still shows.
    const c = commentOn(file, 6, { side: 'new', version: 'worktree' });
    const removed = file.filter((line) => line !== '  two();');
    const { placed } = placeComments([c], changes(file, removed));
    expect(placed).toEqual([{ comment: c, side: 'old', start: 6, end: 6 }]);
  });

  it('draws one side per comment, even when both sides hold the code', () => {
    const c = commentOn(file, 5, { side: 'new', version: 'worktree' });
    const { placed } = placeComments([c], changes(file, file));
    expect(placed).toHaveLength(1);
  });

  describe('The code is deleted', () => {
    it('lists a comment whose lines are on neither side as outdated', () => {
      const c = commentOn(file, 5, { side: 'new', version: 'worktree' }, {}, 6);
      const gone = [...file.slice(0, 4), ...file.slice(6)];
      const { placed, outdated } = placeComments([c], changes(gone, gone));
      expect(placed).toEqual([]);
      expect(outdated).toEqual([c]);
    });

    it('lists a comment on an empty file as outdated', () => {
      const c = commentOn(file, 5, { side: 'new', version: 'worktree' });
      const { outdated } = placeComments([c], changes([], []));
      expect(outdated).toEqual([c]);
    });
  });

  describe('a duplicated block', () => {
    // A comment on `dup`, stored at line 5 with no context to tell copies apart.
    const bare = (over: Partial<ScmComment> = {}): ScmComment =>
      commentOn(['dup'], 1, { side: 'new', version: 'worktree' }, { start: 5, ...over });

    it('is outdated on a tie, never attached to a guess', () => {
      // Copies at lines 3 and 7: both two lines from the old position 5, both
      // with the same (empty) context, so nothing says which one was meant.
      const current = ['a', 'a', 'dup', 'a', 'a', 'a', 'dup', 'a', 'a'];
      const c = bare();
      const { placed, outdated } = placeComments([c], changes(current, current));
      expect(placed).toEqual([]);
      expect(outdated).toEqual([c]);
    });

    it('lets the context agree with one copy and place it', () => {
      const current = ['a', 'b', 'dup', 'c', 'a', 'a', 'dup', 'a', 'a'];
      const c = bare({ before: ['a', 'b'], after: ['c'] });
      const { placed } = placeComments([c], changes(current, current));
      expect(placed).toEqual([{ comment: c, side: 'new', start: 3, end: 3 }]);
    });

    it('lets the distance from the old position decide when the context cannot', () => {
      const current = ['a', 'dup', 'a', 'a', 'a', 'a', 'dup', 'a'];
      const c = bare({ start: 6 });
      const { placed } = placeComments([c], changes(current, current));
      expect(placed).toEqual([{ comment: c, side: 'new', start: 7, end: 7 }]);
    });

    it('is not outdated when the other side finds it uniquely', () => {
      const duplicated = ['a', 'a', 'dup', 'a', 'a', 'a', 'dup', 'a', 'a'];
      const unique = ['a', 'a', 'dup', 'a', 'a'];
      const c = bare();
      const { placed } = placeComments([c], changes(unique, duplicated));
      expect(placed).toEqual([{ comment: c, side: 'old', start: 3, end: 3 }]);
    });
  });

  it('keeps the order the comments came in, in both lists', () => {
    const a = commentOn(file, 9, { side: 'new', version: 'worktree' }, { id: 'a' });
    const lost = commentOn(
      file,
      5,
      { side: 'new', version: 'worktree' },
      { id: 'lost', lines: ['gone'] },
    );
    const b = commentOn(file, 2, { side: 'new', version: 'worktree' }, { id: 'b' });
    const lost2 = commentOn(
      file,
      4,
      { side: 'new', version: 'worktree' },
      { id: 'lost2', lines: ['gone too'] },
    );
    const { placed, outdated } = placeComments([a, lost, b, lost2], changes(file, file));
    expect(placed.map((p) => p.comment.id)).toEqual(['a', 'b']);
    expect(outdated.map((c) => c.id)).toEqual(['lost', 'lost2']);
  });
});

// ── What the review stores, and which sides it places on ─────────────────────

describe('which version each side of a review shows', () => {
  it('is HEAD and the index in Staged, the index and the work tree in Changes', () => {
    expect(versionOf('staged', 'old')).toBe('head');
    expect(versionOf('staged', 'new')).toBe('index');
    expect(versionOf('changes', 'old')).toBe('index');
    expect(versionOf('changes', 'new')).toBe('worktree');
  });

  it('puts a snapshot’s text, as lines, on the sides its group names', () => {
    const snapshot = {
      group: 'staged',
      old: { id: 'o', text: 'a\nb\n' },
      new: { id: 'n', text: 'a\nc\n' },
    } as unknown as ScmFileSnapshot;
    expect(placementSidesOf(snapshot)).toEqual({
      old: { version: 'head', lines: ['a', 'b'] },
      new: { version: 'index', lines: ['a', 'c'] },
    });
  });
});

describe('capturing the code a comment is about', () => {
  const side = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  it('takes the lines and three of context either side', () => {
    expect(captureRange(side, 4, 5)).toEqual({
      lines: ['d', 'e'],
      before: ['a', 'b', 'c'],
      after: ['f', 'g', 'h'],
    });
  });

  it('keeps what context there is at the ends of the file', () => {
    expect(captureRange(side, 1, 1)).toEqual({ lines: ['a'], before: [], after: ['b', 'c', 'd'] });
    expect(captureRange(side, 8, 8)).toEqual({
      lines: ['h'],
      before: ['e', 'f', 'g'],
      after: [],
    });
  });

  it('refuses a range that is not inside the text', () => {
    expect(captureRange(side, 0, 1)).toBeNull();
    expect(captureRange(side, 3, 2)).toBeNull();
    expect(captureRange(side, 8, 9)).toBeNull();
    expect(captureRange([], 1, 1)).toBeNull();
  });

  it('stores the version the commented side showed, and anchors back to the same lines', () => {
    const range = captureRange(side, 4, 5);
    expect(range).not.toBeNull();
    const input = commentInput(
      'changes',
      { path: 'a.ts', side: 'new', start: 4, end: 5 },
      range!,
      'x',
    );
    expect(input).toMatchObject({ version: 'worktree', side: 'new', start: 4, end: 5, body: 'x' });
    const comment = { ...input, id: 'c', createdAt: 1, updatedAt: 1 };
    const placed = placeComments([comment], {
      old: { version: 'index', lines: [] },
      new: { version: 'worktree', lines: side },
    });
    expect(placed.placed).toMatchObject([{ side: 'new', start: 4, end: 5 }]);
  });
});

// ── A file palmux did not read ───────────────────────────────────────────────

describe('placing comments in a snapshot', () => {
  const snap = (over: Partial<ScmFileSnapshot> = {}): ScmFileSnapshot => ({
    path: 'a.ts',
    group: 'changes',
    algorithm: 'histogram',
    old: { id: 'o', text: 'one\ntwo\n' },
    new: { id: 'n', text: 'one\nTWO\nthree\n' },
    hunks: [],
    binary: false,
    tooLarge: false,
    converted: false,
    unmerged: false,
    modes: {},
    attrs: {},
    version: 'v',
    ...over,
  });
  const note = commentOn(['one', 'TWO', 'three'], 2, { side: 'new', version: 'worktree' });

  it('places what the anchor finds and lists the rest as outdated, with nothing unread', () => {
    const gone = commentOn(
      ['one', 'zzz', 'three'],
      2,
      { side: 'new', version: 'worktree' },
      { id: 'gone' },
    );
    const out = placeInSnapshot([note, gone], snap());
    expect(out.placed.map((p) => p.comment.id)).toEqual([note.id]);
    expect(out.outdated.map((c) => c.id)).toEqual(['gone']);
    expect(out.unread).toEqual([]);
  });

  it.each([
    ['too large', { tooLarge: true }],
    ['converted', { converted: true }],
  ] as const)(
    'does not outdate a comment when the file is %s: palmux never read it',
    (_name, over) => {
      // Both sides come back empty, which is what makes every comment look gone.
      const out = placeInSnapshot(
        [note],
        snap({ ...over, old: { id: 'o', text: '' }, new: { id: 'n', text: '' } }),
      );
      expect(out).toEqual({ placed: [], outdated: [], unread: [note] });
    },
  );

  it('knows an unread snapshot by its flags, and a binary or an empty one is not', () => {
    expect(isUnread(snap({ tooLarge: true }))).toBe(true);
    expect(isUnread(snap({ converted: true }))).toBe(true);
    expect(isUnread(snap({ binary: true }))).toBe(false);
    expect(isUnread(snap({ new: { id: 'n', text: '' } }))).toBe(false);
  });
});
