// Copy comments marks as outdated exactly what a review would list as outdated:
// the comments are placed on the same two sides of the same snapshots. What it
// must NOT do is call a comment outdated that it merely could not check.

import { describe, expect, it, vi } from 'vitest';
import type { ScmComment, ScmEntry, ScmFileSnapshot, ScmGroup, ScmStatus } from '@palmux/shared';
import { commentMarks, commentsMarkdown, type ReadSnapshot } from './copy-comments';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}`,
  ...over,
});

const status = (over: Partial<ScmStatus> = {}): ScmStatus => ({
  top: '/work/app',
  unborn: false,
  merge: [],
  staged: [],
  changes: [],
  truncated: false,
  tookMs: 1,
  commentsRev: 1,
  attrEpoch: 'e',
  ...over,
});

const comment = (
  id: string,
  path: string,
  line: string,
  over: Partial<ScmComment> = {},
): ScmComment => ({
  id,
  path,
  version: 'worktree',
  side: 'new',
  start: 2,
  end: 2,
  lines: [line],
  before: ['one'],
  after: ['three'],
  body: `note ${id}`,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const snap = (
  path: string,
  group: ScmGroup,
  oldText: string,
  newText: string,
): ScmFileSnapshot => ({
  path,
  group,
  algorithm: 'histogram',
  old: { id: 'o', text: oldText },
  new: { id: 'n', text: newText },
  hunks: [],
  binary: false,
  tooLarge: false,
  converted: false,
  unmerged: false,
  modes: {},
  attrs: {},
  version: 'v',
});

const reader = (files: Record<string, ScmFileSnapshot | Error>): ReadSnapshot =>
  vi.fn((_repo, group, request) => {
    const found = files[`${group}:${request.path}`];
    if (!found) return Promise.reject(new Error('no such file'));
    return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
  });

describe('which comments are outdated', () => {
  it('is none when every comment’s code is still in the file', async () => {
    const read = reader({
      'changes:a.ts': snap('a.ts', 'changes', 'one\ntwo\n', 'one\nTWO\nthree\n'),
    });
    const out = await commentMarks(
      '/work/app',
      status({ changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'TWO')],
      read,
    );
    expect([...out.outdated]).toEqual([]);
  });

  it('names the comment whose code is gone, and only that one', async () => {
    const read = reader({
      'changes:a.ts': snap('a.ts', 'changes', 'one\ntwo\n', 'one\nTWO\nthree\n'),
    });
    const out = await commentMarks(
      '/work/app',
      status({ changes: [entry('a.ts')] }),
      [comment('alive', 'a.ts', 'TWO'), comment('gone', 'a.ts', 'deleted')],
      read,
    );
    expect([...out.outdated]).toEqual(['gone']);
  });

  it('reads the same group a review of it would, with the rename source', async () => {
    const read = reader({
      'staged:b.ts': snap('b.ts', 'staged', 'one\nTWO\nthree\n', 'one\nTWO\nthree\n'),
    });
    await commentMarks(
      '/work/app',
      status({ staged: [entry('b.ts', { kind: 'rename', status: 'R', oldPath: 'a.ts' })] }),
      [comment('c1', 'b.ts', 'TWO')],
      read,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      '/work/app',
      'staged',
      expect.objectContaining({ path: 'b.ts', oldPath: 'a.ts' }),
      expect.anything(),
    );
  });

  it('counts a comment as alive when ANY of the file’s reviews holds its code', async () => {
    // Partly staged: the staged version has the line, the work tree one does not.
    const read = reader({
      'staged:a.ts': snap('a.ts', 'changes', 'one\ntwo\n', 'one\nTWO\nthree\n'),
      'changes:a.ts': snap('a.ts', 'changes', 'one\nTWO\nthree\n', 'one\nZZZ\nthree\n'),
    });
    const out = await commentMarks(
      '/work/app',
      status({ staged: [entry('a.ts')], changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'TWO', { version: 'index' })],
      read,
    );
    expect([...out.outdated]).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('says nothing of a file that is in no group: its code may well still be there', async () => {
    const read = reader({});
    const out = await commentMarks('/work/app', status(), [comment('c1', 'old.ts', 'x')], read);
    expect([...out.outdated]).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('says nothing of a file it could not read: unknown is not outdated', async () => {
    const read = reader({ 'changes:a.ts': new Error('boom') });
    const out = await commentMarks(
      '/work/app',
      status({ changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'x')],
      read,
    );
    expect([...out.outdated]).toEqual([]);
  });

  it('reads each file once however many comments it has', async () => {
    const read = reader({ 'changes:a.ts': snap('a.ts', 'changes', 'one\n', 'one\nTWO\nthree\n') });
    await commentMarks(
      '/work/app',
      status({ changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'TWO'), comment('c2', 'a.ts', 'nope')],
      read,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not read a conflicted file, which has no diff to place a comment on', async () => {
    const read = reader({});
    await commentMarks(
      '/work/app',
      status({ merge: [entry('m.ts', { kind: 'unmerged', status: 'U' })] }),
      [comment('c1', 'm.ts', 'x')],
      read,
    );
    expect(read).not.toHaveBeenCalled();
  });
});

describe('the document', () => {
  it('carries the outdated mark on the comment that is outdated', async () => {
    const read = reader({ 'changes:a.ts': snap('a.ts', 'changes', 'one\n', 'one\nTWO\nthree\n') });
    const text = await commentsMarkdown(
      '/work/app',
      status({ changes: [entry('a.ts')] }),
      [comment('alive', 'a.ts', 'TWO'), comment('gone', 'a.ts', 'deleted', { start: 9, end: 9 })],
      read,
    );
    expect(text).toMatch(/\*\*L2\*\* \(new\)\n/);
    expect(text).toMatch(/\*\*L9\*\* \(new\) \(outdated\)/);
  });

  it('still produces the document when there is no status to check against', async () => {
    const text = await commentsMarkdown('/work/app', null, [comment('c1', 'a.ts', 'TWO')]);
    expect(text).toContain('## a.ts');
    expect(text).not.toContain('outdated');
  });
});

describe('a file palmux answered but did not read', () => {
  // Both sides come back empty, which is what would make every comment look gone.
  const unread = (path: string, group: ScmGroup, over: Partial<ScmFileSnapshot>) => ({
    ...snap(path, group, '', ''),
    ...over,
  });

  it.each([
    ['too large', { tooLarge: true }],
    ['converted', { converted: true }],
  ] as const)('marks its comments not shown, not outdated, when it is %s', async (_name, over) => {
    const read = reader({ 'changes:a.ts': unread('a.ts', 'changes', over) });
    const out = await commentMarks(
      '/work/app',
      status({ changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'TWO')],
      read,
    );
    expect([...out.unread]).toEqual(['c1']);
    expect([...out.outdated]).toEqual([]);
  });

  it('does not call a comment outdated when its code may be in the review it could not read', async () => {
    // Partly staged: the staged review reads, the changes review is too large.
    const read = reader({
      'staged:a.ts': snap('a.ts', 'staged', 'one\n', 'one\nOTHER\nthree\n'),
      'changes:a.ts': unread('a.ts', 'changes', { tooLarge: true }),
    });
    const out = await commentMarks(
      '/work/app',
      status({ staged: [entry('a.ts')], changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'TWO')],
      read,
    );
    expect([...out.unread]).toEqual(['c1']);
    expect([...out.outdated]).toEqual([]);
  });

  it('leaves a comment alone when the review that was read holds its code', async () => {
    const read = reader({
      'staged:a.ts': snap('a.ts', 'staged', 'one\n', 'one\nTWO\nthree\n'),
      'changes:a.ts': unread('a.ts', 'changes', { converted: true }),
    });
    const out = await commentMarks(
      '/work/app',
      status({ staged: [entry('a.ts')], changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'TWO')],
      read,
    );
    expect([...out.unread]).toEqual([]);
    expect([...out.outdated]).toEqual([]);
  });

  it('says nothing when the one review it needed failed to read at all', async () => {
    const read = reader({ 'changes:a.ts': new Error('boom') });
    const out = await commentMarks(
      '/work/app',
      status({ changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'TWO')],
      read,
    );
    expect([...out.unread, ...out.outdated]).toEqual([]);
  });

  it('puts "not shown" in the document, and no "outdated"', async () => {
    const read = reader({ 'changes:a.ts': unread('a.ts', 'changes', { tooLarge: true }) });
    const text = await commentsMarkdown(
      '/work/app',
      status({ changes: [entry('a.ts')] }),
      [comment('c1', 'a.ts', 'TWO', { start: 4, end: 4 })],
      read,
    );
    expect(text).toContain('**L4** (new) (not shown: file too large / converted)');
    expect(text).not.toContain('outdated');
  });
});
