// The scenario names follow `diff-review` ("Reviewing a file stages it and moves on",
// "A staged file can be unstaged"): the transparent retry on an expired token, the
// refusals each with its own words, and Undo.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmFileSnapshot, ScmWriteResult } from '@palmux/shared';
import { readLastDiscard, recordDiscard } from '../scm/discard-log';
import type { ScmFetchResult } from '../scm/scm-api';
import {
  describeFailure,
  describeNoChange,
  describeWrites,
  draftBlocker,
  reviewBlocker,
  reviewShown,
  undoWrites,
  unstageEntry,
  type WriteDeps,
} from './review-writes';
import type { LoggedWrite } from './write-log';

const snapshot = (over: Partial<ScmFileSnapshot> = {}): ScmFileSnapshot => ({
  path: 'a.ts',
  group: 'changes',
  algorithm: 'histogram',
  old: { id: 'o', text: 'a\n' },
  new: { id: 'n', text: 'b\n' },
  hunks: [],
  binary: false,
  tooLarge: false,
  converted: false,
  unmerged: false,
  modes: {},
  attrs: {},
  version: 'v1',
  token: 't1',
  ...over,
});

/** A snapshot palmux held no token for. */
const untokened = (over: Partial<ScmFileSnapshot> = {}): ScmFileSnapshot => {
  const held = snapshot(over);
  delete held.token;
  return held;
};

const ok = (
  receiptId = 'r1',
  status: ScmWriteResult['status'] = 'staged',
): ScmFetchResult<ScmWriteResult> => ({
  ok: true,
  value: { receiptId, status },
});
const refused = (
  httpStatus: number,
  code?: 'busy' | 'conflict' | 'changed' | 'token' | 'unsupported' | 'df',
  message = 'refused',
): ScmFetchResult<ScmWriteResult> => ({
  ok: false,
  message,
  httpStatus,
  ...(code ? { code } : {}),
});

const deps = (over: Partial<WriteDeps> = {}): WriteDeps => ({
  stage: vi.fn(() => Promise.resolve(ok())),
  unstage: vi.fn(() => Promise.resolve(ok('r2', 'unstaged'))),
  reload: vi.fn(() => Promise.resolve(snapshot({ token: 't2' }))),
  ...over,
});

describe('Reviewed stages the version that was shown', () => {
  it('sends the path and the token of the snapshot, and answers its receipt', async () => {
    const d = deps();
    expect(await reviewShown(d, snapshot())).toEqual({ kind: 'done', receiptId: 'r1' });
    expect(d.stage).toHaveBeenCalledTimes(1);
    expect(d.stage).toHaveBeenCalledWith('a.ts', 't1');
    expect(d.reload).not.toHaveBeenCalled();
  });
});

describe('Reviewed after a long review', () => {
  it('refetches on an expired token and retries once with the new one, without a word', async () => {
    const stage = vi
      .fn<WriteDeps['stage']>()
      .mockResolvedValueOnce(refused(410, 'token'))
      .mockResolvedValueOnce(ok('r9'));
    const d = deps({ stage });
    expect(await reviewShown(d, snapshot())).toEqual({ kind: 'done', receiptId: 'r9' });
    expect(d.reload).toHaveBeenCalledWith('a.ts');
    expect(stage.mock.calls).toEqual([
      ['a.ts', 't1'],
      ['a.ts', 't2'],
    ]);
  });

  it('retries once and never loops: a second expiry is shown, not tried again', async () => {
    const stage = vi.fn<WriteDeps['stage']>(() => Promise.resolve(refused(410, 'token')));
    const d = deps({ stage });
    const outcome = await reviewShown(d, snapshot());
    expect(stage).toHaveBeenCalledTimes(2);
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'notice', message: expect.stringMatching(/no longer held/) });
  });

  it('stages nothing when the file is another version now, and says it changed', async () => {
    const stage = vi.fn<WriteDeps['stage']>(() => Promise.resolve(refused(410, 'token')));
    const d = deps({
      stage,
      reload: vi.fn(() => Promise.resolve(snapshot({ version: 'v2', token: 't2' }))),
    });
    const outcome = await reviewShown(d, snapshot());
    expect(stage).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: 'notice',
      message: expect.stringMatching(/changed since you looked/),
    });
  });

  it('says so when the file cannot be fetched again, and stages nothing', async () => {
    const stage = vi.fn<WriteDeps['stage']>(() => Promise.resolve(refused(410, 'token')));
    const d = deps({ stage, reload: vi.fn(() => Promise.resolve(null)) });
    const outcome = await reviewShown(d, snapshot());
    expect(stage).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('notice');
  });

  it('stops when the newer snapshot of the same version cannot be staged', async () => {
    const stage = vi.fn<WriteDeps['stage']>(() => Promise.resolve(refused(410, 'token')));
    const d = deps({
      stage,
      reload: vi.fn(() => Promise.resolve(untokened({ tooLarge: true }))),
    });
    expect(await reviewShown(d, snapshot())).toEqual({
      kind: 'notice',
      message: expect.stringMatching(/too large/),
    });
    expect(stage).toHaveBeenCalledTimes(1);
  });
});

describe('what each refusal says', () => {
  it.each([
    [409, 'busy', /busy.*Nothing was changed/s],
    [409, 'changed', /changed since you looked.*nothing was staged/s],
    [501, 'unsupported', /cannot do this here: split index/],
    [409, 'df', /Git refused: split index/],
  ] as const)('%i %s', async (status, code, text) => {
    const d = deps({ stage: vi.fn(() => Promise.resolve(refused(status, code, 'split index'))) });
    const outcome = await reviewShown(d, snapshot());
    expect(outcome).toEqual({ kind: 'notice', message: expect.stringMatching(text) });
  });

  it('shows the server’s own words for a refusal with no code, and for no answer at all', async () => {
    const d = deps({
      stage: vi.fn(() => Promise.resolve(refused(409, undefined, 'conflicted file'))),
    });
    expect(await reviewShown(d, snapshot())).toEqual({
      kind: 'notice',
      message: 'conflicted file',
    });
    const offline = deps({
      stage: vi.fn(() =>
        Promise.resolve({ ok: false as const, message: 'Cannot reach palmux', httpStatus: 0 }),
      ),
    });
    expect(await reviewShown(offline, snapshot())).toEqual({
      kind: 'notice',
      message: 'Cannot reach palmux',
    });
  });

  it('reads the newer version of a file whose attribute context moved', async () => {
    const d = deps({ stage: vi.fn(() => Promise.resolve(refused(409, 'changed'))) });
    await reviewShown(d, snapshot());
    expect(d.reload).toHaveBeenCalledWith('a.ts');
  });

  it('names an expired Undo as such', () => {
    expect(
      describeFailure({ ok: false, message: 'x', httpStatus: 410, code: 'token' }, 'undo'),
    ).toBe('Undo is no longer available.');
  });

  it('words a refused discard, or its Undo, by the files and not the index', () => {
    const refusal = (code: 'busy' | 'conflict' | 'token' | 'changed', message = 'x') =>
      describeFailure({ ok: false, message, httpStatus: 409, code }, 'discard');
    expect(refusal('conflict')).toBe('The files changed since the discard');
    // The server's own count of what it put back is kept.
    const partial =
      'The files changed since the discard; 1 of 2 were restored, and Undo keeps the rest.';
    expect(refusal('conflict', partial)).toBe(partial);
    expect(refusal('token')).toBe('This Undo has expired');
    expect(refusal('changed')).toBe(
      'The files changed since you confirmed; nothing was discarded.',
    );
    expect(refusal('busy')).toBe(
      describeFailure({ ok: false, message: 'x', httpStatus: 409, code: 'busy' }, 'stage'),
    );
    // Every other action keeps its wording.
    expect(
      describeFailure({ ok: false, message: 'x', httpStatus: 409, code: 'conflict' }, 'undo'),
    ).toBe('The index changed since; nothing was undone.');
  });
});

describe('A file palmux cannot snapshot', () => {
  it.each([
    ['too large', { tooLarge: true }, /too large/],
    ['converted', { converted: true }, /converted by git/],
    ['otherwise unstageable', {}, /cannot stage this version/],
  ] as const)(
    'is not reviewable when %s: it has no token and the reason is given',
    (_n, over, text) => {
      const none = untokened(over);
      expect(reviewBlocker({ kind: 'ordinary' }, none)).toMatch(text);
    },
  );

  it('is reviewable with a token, and not before it has loaded', () => {
    expect(reviewBlocker({ kind: 'ordinary' }, snapshot())).toBeNull();
    expect(reviewBlocker({ kind: 'ordinary' }, undefined)).toMatch(/not loaded yet/);
  });

  it('is never reviewable while conflicted', () => {
    expect(reviewBlocker({ kind: 'unmerged' }, undefined)).toMatch(/conflicts/);
  });

  it('stages nothing for a snapshot with no token', async () => {
    const d = deps();
    const outcome = await reviewShown(d, untokened({ tooLarge: true }));
    expect(outcome.kind).toBe('notice');
    expect(d.stage).not.toHaveBeenCalled();
  });
});

describe('A file with a comment open on it', () => {
  it('is held until that comment is saved or cancelled, naming the file', () => {
    expect(draftBlocker([{ path: 'src/a.ts', scope: 'changes' }], 'src/a.ts', 'changes')).toBe(
      'Save or cancel the comment on a.ts first.',
    );
  });

  it('is not held by a comment on another file, or open in the other review', () => {
    expect(draftBlocker([{ path: 'b.ts', scope: 'changes' }], 'a.ts', 'changes')).toBeNull();
    expect(draftBlocker([{ path: 'a.ts', scope: 'staged' }], 'a.ts', 'changes')).toBeNull();
    expect(draftBlocker([], 'a.ts', 'changes')).toBeNull();
  });
});

describe('Unstage', () => {
  it('sends the path, and the source of a rename', async () => {
    const d = deps();
    expect(await unstageEntry(d, { path: 'b.ts', oldPath: 'a.ts' })).toEqual({
      kind: 'done',
      receiptId: 'r2',
    });
    expect(d.unstage).toHaveBeenCalledWith('b.ts', 'a.ts');
    await unstageEntry(d, { path: 'c.ts' });
    expect(d.unstage).toHaveBeenLastCalledWith('c.ts', undefined);
  });

  it('says a busy index is busy', async () => {
    const d = deps({ unstage: vi.fn(() => Promise.resolve(refused(409, 'busy'))) });
    expect(await unstageEntry(d, { path: 'a.ts' })).toEqual({
      kind: 'notice',
      message: expect.stringMatching(/busy/),
    });
  });
});

const logged = (receiptId: string, over: Partial<LoggedWrite> = {}): LoggedWrite => ({
  repo: '/work/app',
  receiptId,
  action: 'stage',
  name: `${receiptId}.ts`,
  at: 0,
  ...over,
});

const restoring = (...answers: ScmFetchResult<ScmWriteResult>[]) => {
  const restore = vi.fn((_repo: string, _receiptId: string) => {
    const next = answers.shift();
    return Promise.resolve(next ?? ok('rx', 'restored'));
  });
  return restore;
};

describe('Undo', () => {
  it('restores by receipt, in the project that issued it', async () => {
    const restore = restoring();
    expect(await undoWrites(restore, [logged('r1', { repo: '/work/lib' })])).toEqual({
      kind: 'done',
      undone: 1,
    });
    expect(restore).toHaveBeenCalledWith('/work/lib', 'r1');
  });

  it('says the index changed since, and that nothing was undone', async () => {
    const restore = restoring(refused(409, 'conflict'));
    expect(await undoWrites(restore, [logged('r1')])).toEqual({
      kind: 'notice',
      undone: 0,
      message: 'The index changed since; nothing was undone.',
    });
  });

  it('takes back every write it is given, newest first', async () => {
    const restore = restoring();
    const outcome = await undoWrites(restore, [logged('r1'), logged('r2'), logged('r3')]);
    expect(outcome).toEqual({ kind: 'done', undone: 3 });
    expect(restore.mock.calls.map(([, id]) => id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('stops at the first conflict: the older writes are left alone, and the reader is told how far it got', async () => {
    const restore = restoring(ok('x', 'restored'), refused(409, 'conflict'));
    const outcome = await undoWrites(restore, [logged('r1'), logged('r2'), logged('r3')]);
    expect(restore.mock.calls.map(([, id]) => id)).toEqual(['r3', 'r2']); // r1 was never tried
    expect(outcome).toEqual({
      kind: 'notice',
      undone: 1,
      message: 'Undid 1 of 3. The index changed since for the rest, so they were left as they are.',
    });
  });

  it('says why an expired receipt stopped it, after a first success', async () => {
    const restore = restoring(ok('x', 'restored'), refused(410, 'token'));
    const outcome = await undoWrites(restore, [logged('r1'), logged('r2')]);
    expect(outcome).toEqual({
      kind: 'notice',
      undone: 1,
      message: 'Undid 1 of 2. Undo is no longer available.',
    });
  });
});

describe('describeWrites', () => {
  it('names the file when there is one write', () => {
    expect(describeWrites([logged('r1', { name: 'a.ts' })])).toBe('Reviewed a.ts');
    expect(describeWrites([logged('r1', { name: 'a.ts', action: 'unstage' })])).toBe(
      'Unstaged a.ts',
    );
  });

  it('counts the files when there are several', () => {
    expect(describeWrites([logged('r1'), logged('r2')])).toBe('Staged 2 files');
    expect(
      describeWrites([logged('r1', { action: 'unstage' }), logged('r2', { action: 'unstage' })]),
    ).toBe('Unstaged 2 files');
  });

  it('says both when staging and unstaging are mixed', () => {
    expect(describeWrites([logged('r1'), logged('r2', { action: 'unstage' }), logged('r3')])).toBe(
      'Staged 2 files, unstaged 1 file',
    );
  });

  it('says Staged, not Reviewed, for one file staged from the list', () => {
    expect(describeWrites([logged('r1', { name: 'a.ts', via: 'list' })])).toBe('Staged a.ts');
    expect(describeWrites([logged('r1', { name: 'a.ts', via: 'list', count: 1 })])).toBe(
      'Staged a.ts',
    );
  });

  it('names a discard', () => {
    expect(describeWrites([logged('d1', { name: 'a.ts', action: 'discard' })])).toBe(
      'Discarded a.ts',
    );
  });

  it('names the count of a write that changed many files', () => {
    expect(describeWrites([logged('r1', { name: 'src', via: 'list', count: 40 })])).toBe(
      'Staged 40 files',
    );
    expect(describeWrites([logged('r1', { action: 'unstage', via: 'list', count: 3 })])).toBe(
      'Unstaged 3 files',
    );
  });

  it('sums the counts per action, staged then unstaged then discarded', () => {
    expect(
      describeWrites([
        logged('d1', { action: 'discard', count: 2 }),
        logged('r1', { count: 40, via: 'list' }),
        logged('u1', { action: 'unstage' }),
      ]),
    ).toBe('Staged 40 files, unstaged 1 file, discarded 2 files');
    expect(
      describeWrites([
        logged('r1', { count: 40, via: 'list' }),
        logged('d1', { action: 'discard', count: 2 }),
      ]),
    ).toBe('Staged 40 files, discarded 2 files');
    expect(
      describeWrites([logged('d1', { action: 'discard' }), logged('d2', { action: 'discard' })]),
    ).toBe('Discarded 2 files');
  });

  it('appends the skips, with the reason when every skip has the same one', () => {
    expect(
      describeWrites([
        logged('r1', {
          count: 38,
          via: 'list',
          skipped: [
            { path: 'a', reason: 'converted' },
            { path: 'b', reason: 'converted' },
          ],
        }),
      ]),
    ).toBe('Staged 38 files, skipped 2 (needs a git filter)');
  });

  it('gives each reason with its count when they differ, summed across writes', () => {
    expect(
      describeWrites([
        logged('r1', {
          count: 5,
          skipped: [
            { path: 'a', reason: 'converted' },
            { path: 'c', reason: 'converted' },
          ],
        }),
        logged('r2', { count: 5, skipped: [{ path: 'b', reason: 'gone' }] }),
      ]),
    ).toBe('Staged 10 files, skipped 3 (needs a git filter: 2, no longer changed: 1)');
  });

  it('names the one file a batch skipped', () => {
    expect(
      describeWrites([
        logged('d1', {
          action: 'discard',
          count: 3,
          via: 'list',
          skipped: [{ path: 'src/lib/link.ts', reason: 'symlink' }],
        }),
      ]),
    ).toBe('Discarded 3 files, skipped link.ts (a symbolic link)');
  });

  it('appends the skips to a one-file write too', () => {
    expect(
      describeWrites([
        logged('r1', { name: 'a.ts', via: 'list', skipped: [{ path: 'b', reason: 'unmerged' }] }),
      ]),
    ).toBe('Staged a.ts, skipped b (unmerged)');
  });
});

describe('describeNoChange', () => {
  it('says nothing changed, for each action', () => {
    expect(describeNoChange('stage', [])).toBe('Nothing staged');
    expect(describeNoChange('unstage', [])).toBe('Nothing unstaged');
    expect(describeNoChange('discard', [])).toBe('Nothing discarded');
  });

  it('gives the skip suffix of the other toasts', () => {
    expect(
      describeNoChange('stage', [
        { path: 'a', reason: 'converted' },
        { path: 'b', reason: 'converted' },
      ]),
    ).toBe('Nothing staged, skipped 2 (needs a git filter)');
    expect(
      describeNoChange('discard', [
        { path: 'a', reason: 'gone' },
        { path: 'b', reason: 'changed' },
      ]),
    ).toBe('Nothing discarded, skipped 2 (no longer changed: 1, changed since you confirmed: 1)');
  });
});

describe('Undo of a discard', () => {
  it('says the files changed since the discard when its receipt conflicts', async () => {
    const restore = restoring(refused(409, 'conflict'));
    expect(await undoWrites(restore, [logged('d1', { action: 'discard' })])).toEqual({
      kind: 'notice',
      undone: 0,
      message: 'The files changed since the discard',
    });
  });

  it("keeps the server's count when an Undo of a discard stopped part way", async () => {
    const partial =
      'The files changed since the discard; 1 of 2 were restored, and Undo keeps the rest.';
    const restore = restoring(refused(409, 'conflict', partial));
    expect(await undoWrites(restore, [logged('d1', { action: 'discard' })])).toEqual({
      kind: 'notice',
      undone: 0,
      message: partial,
    });
  });

  it('says an expired discard receipt has expired, and takes the project bar’s Undo away', async () => {
    localStorage.clear();
    recordDiscard('/work/app', { receiptId: 'd1', at: Date.now(), count: 2 });
    const restore = restoring(refused(410, 'token'));
    expect(await undoWrites(restore, [logged('d1', { action: 'discard' })])).toEqual({
      kind: 'notice',
      undone: 0,
      message: 'This Undo has expired',
    });
    expect(readLastDiscard('/work/app')).toBeNull();
  });

  it('keeps the index wording for an expired index receipt', async () => {
    expect(await undoWrites(restoring(refused(410, 'token')), [logged('r1')])).toMatchObject({
      message: 'Undo is no longer available.',
    });
  });

  it('uses the discard wording only for the write that conflicted', async () => {
    // Newest first: the discard is undone, then the stage conflicts.
    const stageConflicts = restoring(ok('x', 'restored'), refused(409, 'conflict'));
    expect(
      await undoWrites(stageConflicts, [logged('r1'), logged('d1', { action: 'discard' })]),
    ).toMatchObject({
      undone: 1,
      message: 'Undid 1 of 2. The index changed since for the rest, so they were left as they are.',
    });
    // The stage is undone, then the discard conflicts.
    const discardConflicts = restoring(ok('x', 'restored'), refused(409, 'conflict'));
    expect(
      await undoWrites(discardConflicts, [logged('d1', { action: 'discard' }), logged('r1')]),
    ).toMatchObject({ undone: 1, message: 'Undid 1 of 2. The files changed since the discard' });
  });
});

describe('Undo of a discard, wherever it runs, takes the project bar’s Undo away', () => {
  // The review's toast can hold a discard the list made: both share the window's write log.
  beforeEach(() => localStorage.clear());
  const discard = logged('d1', { action: 'discard' });

  it('forgets the project’s last discard once its receipt is restored', async () => {
    recordDiscard('/work/app', { receiptId: 'd1', at: Date.now(), count: 2 });
    expect(await undoWrites(restoring(), [discard, logged('r1')])).toEqual({
      kind: 'done',
      undone: 2,
    });
    expect(readLastDiscard('/work/app')).toBeNull();
  });

  it('keeps it when the restore is refused, so the project bar can try again later', async () => {
    recordDiscard('/work/app', { receiptId: 'd1', at: Date.now(), count: 2 });
    await undoWrites(restoring(refused(409, 'conflict')), [discard]);
    expect(readLastDiscard('/work/app')).toMatchObject({ receiptId: 'd1' });
  });

  it('keeps a newer discard, and touches nothing for a stage', async () => {
    recordDiscard('/work/app', { receiptId: 'd2', at: Date.now(), count: 1 });
    await undoWrites(restoring(), [discard, logged('r1')]);
    expect(readLastDiscard('/work/app')).toMatchObject({ receiptId: 'd2' });
  });

  it('forgets it in the project that issued the receipt', async () => {
    recordDiscard('/work/app', { receiptId: 'd1', at: Date.now(), count: 2 });
    recordDiscard('/work/lib', { receiptId: 'd3', at: Date.now(), count: 1 });
    await undoWrites(restoring(), [logged('d3', { action: 'discard', repo: '/work/lib' })]);
    expect(readLastDiscard('/work/lib')).toBeNull();
    expect(readLastDiscard('/work/app')).toMatchObject({ receiptId: 'd1' });
  });
});
