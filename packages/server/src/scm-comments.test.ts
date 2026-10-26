import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCM_COMMENT_LIMITS, type ScmCommentInput } from '@palmux/shared';

type StoreModule = typeof import('./scm-comments');

const TOP = '/work/project';
const created: string[] = [];

/** A clean config dir and a fresh copy of the module (its rev and queue maps are module state). */
async function freshStore(): Promise<{ dir: string; store: StoreModule }> {
  const dir = mkdtempSync(join(tmpdir(), 'palmux-scm-comments-'));
  created.push(dir);
  process.env['PALMUX_CONFIG_DIR'] = dir;
  vi.resetModules();
  return { dir, store: await import('./scm-comments') };
}

const storeFile = (dir: string, top = TOP) =>
  join(dir, '.cache', 'scm', `${createHash('sha256').update(top).digest('hex').slice(0, 16)}.json`);

function input(overrides: Record<string, unknown> = {}): ScmCommentInput {
  return {
    path: 'src/a.ts',
    version: 'worktree',
    side: 'new',
    start: 10,
    end: 11,
    lines: ['const a = 1;', 'const b = 2;'],
    before: ['import x;'],
    after: ['export {};'],
    body: 'rename this',
    ...overrides,
  } as ScmCommentInput;
}

beforeEach(() => {
  delete process.env['PALMUX_CONFIG_DIR'];
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env['PALMUX_CONFIG_DIR'];
});

describe('store layout', () => {
  it('writes <configDir>/.cache/scm/<sha256 prefix>.json and a .gitignore holding *', async () => {
    const { dir, store } = await freshStore();
    await store.createComment(TOP, input());

    expect(existsSync(storeFile(dir))).toBe(true);
    expect(readFileSync(join(dir, '.cache', '.gitignore'), 'utf8')).toBe('*\n');
    expect(JSON.parse(readFileSync(storeFile(dir), 'utf8'))).toMatchObject({
      v: 1,
      repo: TOP,
      rev: 1,
      comments: [{ path: 'src/a.ts', body: 'rename this' }],
    });
  });

  it('names the file by the first 16 hex digits of sha256(top)', async () => {
    const { dir, store } = await freshStore();
    await store.createComment('/work/other', input());
    const [name] = readdirSync(join(dir, '.cache', 'scm'));
    expect(name).toMatch(/^[0-9a-f]{16}\.json$/);
    expect(name).toBe(
      `${createHash('sha256').update('/work/other').digest('hex').slice(0, 16)}.json`,
    );
  });

  it('leaves the config dir root .gitignore untouched', async () => {
    const { dir, store } = await freshStore();
    writeFileSync(join(dir, '.gitignore'), 'secret\n');
    await store.createComment(TOP, input());
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('secret\n');
  });

  it('does not create a root .gitignore either', async () => {
    const { dir, store } = await freshStore();
    await store.createComment(TOP, input());
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('never overwrites a .cache/.gitignore the user already has', async () => {
    const { dir, store } = await freshStore();
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, '.cache', '.gitignore'), 'mine\n');
    await store.createComment(TOP, input());
    expect(readFileSync(join(dir, '.cache', '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('adds the .gitignore to a .cache that predates it', async () => {
    const { dir, store } = await freshStore();
    mkdirSync(join(dir, '.cache'), { recursive: true });
    await store.createComment(TOP, input());
    expect(readFileSync(join(dir, '.cache', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('a read creates nothing', async () => {
    const { dir, store } = await freshStore();
    expect(await store.listComments(TOP)).toEqual({ rev: 0, comments: [] });
    expect(existsSync(join(dir, '.cache'))).toBe(false);
  });

  it('keeps the file private and leaves no temp files behind', async () => {
    const { dir, store } = await freshStore();
    await store.createComment(TOP, input());
    await store.createComment(TOP, input({ body: 'second' }));
    expect(statSync(storeFile(dir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, '.cache', 'scm')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps projects apart', async () => {
    const { store } = await freshStore();
    await store.createComment('/work/one', input({ body: 'one' }));
    await store.createComment('/work/two', input({ body: 'two' }));
    expect((await store.listComments('/work/one')).comments.map((c) => c.body)).toEqual(['one']);
    expect((await store.listComments('/work/two')).comments.map((c) => c.body)).toEqual(['two']);
  });

  it('rejects a repo that is not an absolute path', async () => {
    const { store } = await freshStore();
    await expect(store.listComments('work/project')).rejects.toMatchObject({ status: 400 });
    await expect(store.createComment('', input())).rejects.toMatchObject({ status: 400 });
    expect(() => store.latestRev('work/project')).toThrow(/absolute/);
  });
});

describe('operations answer the whole list and its rev', () => {
  it('creates, edits and deletes, bumping the rev on every write', async () => {
    const { store } = await freshStore();

    const first = await store.createComment(TOP, input());
    expect(first.rev).toBe(1);
    expect(first.comments).toHaveLength(1);
    const comment = first.comments[0]!;
    expect(comment).toMatchObject({ ...input(), id: expect.any(String) });
    expect(comment.createdAt).toBe(comment.updatedAt);

    const second = await store.createComment(TOP, input({ body: 'other', path: 'b.ts' }));
    expect(second.rev).toBe(2);
    expect(second.comments.map((c) => c.body)).toEqual(['rename this', 'other']);
    expect(new Set(second.comments.map((c) => c.id)).size).toBe(2);

    const edited = await store.updateComment(TOP, comment.id, { body: 'fixed wording' });
    expect(edited.rev).toBe(3);
    const after = edited.comments.find((c) => c.id === comment.id)!;
    expect(after).toMatchObject({
      ...input(),
      body: 'fixed wording',
      createdAt: comment.createdAt,
    });
    expect(after.updatedAt).toBeGreaterThanOrEqual(comment.updatedAt);
    expect(edited.comments.map((c) => c.body)).toEqual(['fixed wording', 'other']);

    const removed = await store.deleteComment(TOP, comment.id);
    expect(removed.rev).toBe(4);
    expect(removed.comments.map((c) => c.body)).toEqual(['other']);
    expect(await store.listComments(TOP)).toEqual(removed);
  });

  it('allows an empty body, since an empty comment is deleted without asking', async () => {
    const { store } = await freshStore();
    const { comments } = await store.createComment(TOP, input({ body: '' }));
    expect(comments[0]?.body).toBe('');
  });

  it('ignores an id, timestamps or unknown keys the caller sends', async () => {
    const { store } = await freshStore();
    const { comments } = await store.createComment(
      TOP,
      input({ id: 'mine', createdAt: 1, updatedAt: 2, extra: true }),
    );
    expect(comments[0]?.id).not.toBe('mine');
    expect(comments[0]?.createdAt).toBeGreaterThan(1000);
    expect(comments[0]).not.toHaveProperty('extra');
  });

  it('a patch may change any content field, and the merge is validated whole', async () => {
    const { store } = await freshStore();
    const { comments } = await store.createComment(TOP, input());
    const id = comments[0]!.id;

    const moved = await store.updateComment(TOP, id, {
      start: 20,
      end: 20,
      lines: ['const c = 3;'],
      side: 'old',
    });
    expect(moved.comments[0]).toMatchObject({
      start: 20,
      end: 20,
      lines: ['const c = 3;'],
      side: 'old',
    });

    // A range that no longer matches the quoted lines is refused, and nothing is written.
    await expect(store.updateComment(TOP, id, { end: 25 })).rejects.toMatchObject({ status: 400 });
    expect((await store.listComments(TOP)).rev).toBe(moved.rev);
  });

  it('ignores id and timestamps in a patch, and refuses an empty one', async () => {
    const { store } = await freshStore();
    const { comments } = await store.createComment(TOP, input());
    const comment = comments[0]!;

    const edited = await store.updateComment(TOP, comment.id, { id: 'x', createdAt: 5, body: 'b' });
    expect(edited.comments[0]).toMatchObject({
      id: comment.id,
      createdAt: comment.createdAt,
      body: 'b',
    });

    await expect(store.updateComment(TOP, comment.id, {})).rejects.toMatchObject({ status: 400 });
    await expect(store.updateComment(TOP, comment.id, { id: 'x' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.updateComment(TOP, comment.id, 'body')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('answers 404 for an edit of an unknown comment and writes nothing', async () => {
    const { store } = await freshStore();
    await store.createComment(TOP, input());
    await expect(store.updateComment(TOP, 'nope', { body: 'x' })).rejects.toMatchObject({
      status: 404,
    });
    expect((await store.listComments(TOP)).rev).toBe(1);
  });

  it('deleting a comment that is already gone answers the current list without a write', async () => {
    const { store } = await freshStore();
    const { comments } = await store.createComment(TOP, input());
    const id = comments[0]!.id;
    const removed = await store.deleteComment(TOP, id);
    expect(removed).toEqual({ rev: 2, comments: [] });
    expect(await store.deleteComment(TOP, id)).toEqual({ rev: 2, comments: [] });
  });

  it('reads back from disk in a fresh process', async () => {
    const { dir, store } = await freshStore();
    await store.createComment(TOP, input({ body: 'persisted' }));

    vi.resetModules();
    process.env['PALMUX_CONFIG_DIR'] = dir;
    const reopened: StoreModule = await import('./scm-comments');
    const list = await reopened.listComments(TOP);
    expect(list.rev).toBe(1);
    expect(list.comments.map((c) => c.body)).toEqual(['persisted']);
    expect((await reopened.createComment(TOP, input())).rev).toBe(2);
  });
});

describe('two writers', () => {
  it('interleaved writes keep each other changes and number the revs without gaps', async () => {
    const { store } = await freshStore();
    const seed = await store.createComment(TOP, input({ body: 'seed' }));
    const seedId = seed.comments[0]!.id;

    // Started together, never awaited in between: the desktop adds two comments
    // while the phone deletes the seed.
    const [a, b, c] = await Promise.all([
      store.createComment(TOP, input({ body: 'desktop 1' })),
      store.deleteComment(TOP, seedId),
      store.createComment(TOP, input({ body: 'desktop 2' })),
    ]);

    expect([a.rev, b.rev, c.rev]).toEqual([2, 3, 4]);
    const final = await store.listComments(TOP);
    expect(final.rev).toBe(4);
    expect(final.comments.map((x) => x.body)).toEqual(['desktop 1', 'desktop 2']);
    // Each answer is the authoritative list as of its own write.
    expect(b.comments.map((x) => x.body)).toEqual(['desktop 1']);
    expect(c.comments.map((x) => x.body)).toEqual(['desktop 1', 'desktop 2']);
  });

  it('a failing operation does not stall the ones queued behind it', async () => {
    const { store } = await freshStore();
    const results = await Promise.allSettled([
      store.updateComment(TOP, 'missing', { body: 'x' }),
      store.createComment(TOP, input({ body: 'after the failure' })),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
    expect((await store.listComments(TOP)).comments.map((x) => x.body)).toEqual([
      'after the failure',
    ]);
  });

  it('many concurrent writers lose nothing', async () => {
    const { store } = await freshStore();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.createComment(TOP, input({ body: `c${i}` }))),
    );
    const list = await store.listComments(TOP);
    expect(list.rev).toBe(25);
    expect(new Set(list.comments.map((c) => c.body)).size).toBe(25);
  });
});

describe('latestRev', () => {
  it('is 0 for a project with no comments, and tracks every write', async () => {
    const { store } = await freshStore();
    expect(store.latestRev(TOP)).toBe(0);
    const first = await store.createComment(TOP, input());
    expect(store.latestRev(TOP)).toBe(1);
    await store.updateComment(TOP, first.comments[0]!.id, { body: 'x' });
    expect(store.latestRev(TOP)).toBe(2);
    await store.deleteComment(TOP, first.comments[0]!.id);
    expect(store.latestRev(TOP)).toBe(3);
    expect(store.latestRev('/work/untouched')).toBe(0);
  });

  // An unreadable store file used to throw out of `latestRev`, which every status
  // answer calls: GET /scm/status was a 500 on every poll until someone fixed the file.
  it('reports 0 and warns once for a store file it cannot read, and picks the file up when it can', async () => {
    const { dir, store } = await freshStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A directory where the file belongs: readFileSync answers EISDIR.
      mkdirSync(storeFile(dir), { recursive: true });
      expect(store.latestRev(TOP)).toBe(0);
      expect(store.latestRev(TOP)).toBe(0);
      expect(store.latestRev(TOP)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(storeFile(dir));

      // Nothing was cached for the failure: once the file is readable, it is read.
      rmSync(storeFile(dir), { recursive: true, force: true });
      writeFileSync(storeFile(dir), JSON.stringify({ v: 1, repo: TOP, rev: 5, comments: [] }));
      expect(store.latestRev(TOP)).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the last known rev when the file later turns unreadable', async () => {
    const { dir, store } = await freshStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await store.createComment(TOP, input());
      expect(store.latestRev(TOP)).toBe(1);
      rmSync(storeFile(dir), { force: true });
      mkdirSync(storeFile(dir));
      expect(store.latestRev(TOP)).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('is read from the file after a restart, before anything lists the comments', async () => {
    const { dir, store } = await freshStore();
    await store.createComment(TOP, input());
    await store.createComment(TOP, input());

    vi.resetModules();
    process.env['PALMUX_CONFIG_DIR'] = dir;
    const reopened: StoreModule = await import('./scm-comments');
    expect(reopened.latestRev(TOP)).toBe(2);
  });
});

describe('validation', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['an absolute path', { path: '/etc/passwd' }],
    ['a path with a .. segment', { path: 'a/../../b' }],
    ['a path that is only ..', { path: '..' }],
    ['a path with a NUL', { path: 'a\0b' }],
    ['an empty path', { path: '' }],
    ['a path that is not a string', { path: 7 }],
    ['a path past the length cap', { path: 'a'.repeat(SCM_COMMENT_LIMITS.pathChars + 1) }],
    ['an unknown version', { version: 'staged' }],
    ['a missing version', { version: undefined }],
    ['an unknown side', { side: 'left' }],
    ['a start of 0', { start: 0 }],
    ['a negative start', { start: -3 }],
    ['a fractional start', { start: 1.5 }],
    ['a string start', { start: '10' }],
    ['an end before the start', { start: 12, end: 11 }],
    ['an end that is not an integer', { end: NaN }],
    ['lines that are not an array', { lines: 'const a' }],
    ['lines holding a non-string', { lines: ['a', 2] }],
    ['no lines for the range', { lines: [] }],
    ['fewer lines than the range', { lines: ['only one'] }],
    ['before that is not an array', { before: null }],
    ['before holding a non-string', { before: [1] }],
    ['after past the context cap', { after: Array(SCM_COMMENT_LIMITS.context + 1).fill('x') }],
    ['a body that is not a string', { body: 5 }],
    ['a body past the cap', { body: 'x'.repeat(SCM_COMMENT_LIMITS.bodyBytes + 1) }],
    [
      'a body past the cap in bytes, not characters',
      { body: 'é'.repeat(SCM_COMMENT_LIMITS.bodyBytes / 2 + 1) },
    ],
  ];

  it.each(bad)('refuses %s and writes nothing', async (_label, overrides) => {
    const { dir, store } = await freshStore();
    await expect(store.createComment(TOP, input(overrides))).rejects.toMatchObject({
      name: 'ScmCommentError',
      status: 400,
    });
    expect(existsSync(storeFile(dir))).toBe(false);
    expect(store.latestRev(TOP)).toBe(0);
  });

  it('refuses a comment that is not an object', async () => {
    const { store } = await freshStore();
    await Promise.all(
      [null, undefined, 'x', 3, []].map((value) =>
        expect(store.createComment(TOP, value)).rejects.toMatchObject({ status: 400 }),
      ),
    );
  });

  it('refuses commented code past the total size cap', async () => {
    const { store } = await freshStore();
    const line = 'x'.repeat(SCM_COMMENT_LIMITS.textBytes / 2 + 1);
    await expect(
      store.createComment(
        TOP,
        input({ start: 1, end: 2, lines: [line, line], before: [], after: [] }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts the limits themselves', async () => {
    const { store } = await freshStore();
    const lines = Array.from({ length: SCM_COMMENT_LIMITS.lines }, (_, i) => `line ${i}`);
    const { comments } = await store.createComment(
      TOP,
      input({
        start: 1,
        end: SCM_COMMENT_LIMITS.lines,
        lines,
        before: Array(SCM_COMMENT_LIMITS.context).fill('b'),
        after: Array(SCM_COMMENT_LIMITS.context).fill('a'),
        body: 'x'.repeat(SCM_COMMENT_LIMITS.bodyBytes),
        path: 'dir/..hidden/file..ts',
      }),
    );
    expect(comments).toHaveLength(1);
  });

  it('keeps whitespace in a path, as every other path in palmux', async () => {
    const { store } = await freshStore();
    const { comments } = await store.createComment(TOP, input({ path: 'report /x.ts ' }));
    expect(comments[0]?.path).toBe('report /x.ts ');
  });
});

describe('a damaged file', () => {
  it('reads as an empty project when it is not JSON, and the next write replaces it', async () => {
    const { dir, store } = await freshStore();
    mkdirSync(join(dir, '.cache', 'scm'), { recursive: true });
    writeFileSync(storeFile(dir), '{not json');

    expect(await store.listComments(TOP)).toEqual({ rev: 0, comments: [] });
    const written = await store.createComment(TOP, input());
    expect(written.rev).toBe(1);
    expect(JSON.parse(readFileSync(storeFile(dir), 'utf8')).comments).toHaveLength(1);
  });

  it('drops a stored comment that no longer validates and keeps the rest and the rev', async () => {
    const { dir, store } = await freshStore();
    const good = { id: 'ok', ...input(), createdAt: 1, updatedAt: 2 };
    mkdirSync(join(dir, '.cache', 'scm'), { recursive: true });
    writeFileSync(
      storeFile(dir),
      JSON.stringify({
        v: 1,
        repo: TOP,
        rev: 7,
        comments: [
          good,
          { ...good, id: 'escaped', path: '../etc/passwd' },
          { ...good, id: '' },
          'junk',
        ],
      }),
    );

    const list = await store.listComments(TOP);
    expect(list.rev).toBe(7);
    expect(list.comments.map((c) => c.id)).toEqual(['ok']);
    expect(store.latestRev(TOP)).toBe(7);
  });
});
