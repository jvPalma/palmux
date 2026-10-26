// Status: the porcelain v2 and numstat parsers, the groups on a real repository,
// fingerprints, coalescing, attrEpoch, and that reading never disturbs git.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ScmEntry } from '@palmux/shared';
import { setGitObserver } from './scm-git';
import {
  STATUS_ENTRY_LIMIT,
  getStatus,
  invalidateStatus,
  parseNumstat,
  parsePorcelainV2,
  type ScmStatusCore,
} from './scm-status';

const exec = promisify(execFile);

let home: string;
let savedHome: string | undefined;
let savedXdg: string | undefined;
const created: string[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'palmux-scm-home-'));
  await writeFile(
    join(home, '.gitconfig'),
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  savedHome = process.env['HOME'];
  savedXdg = process.env['XDG_CONFIG_HOME'];
  process.env['HOME'] = home;
  delete process.env['XDG_CONFIG_HOME'];
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  if (savedXdg !== undefined) process.env['XDG_CONFIG_HOME'] = savedXdg;
  await Promise.all([home, ...created].map((dir) => rm(dir, { recursive: true, force: true })));
});

afterEach(() => setGitObserver(null));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout;
}

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'palmux-scm-status-')));
  created.push(dir);
  return dir;
}

async function put(dir: string, rel: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content);
}

async function makeRepo(files: Record<string, string | Buffer> = {}, commit = true): Promise<string> {
  const dir = await tempDir();
  await git(dir, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
  if (commit) {
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

async function statusOf(dir: string): Promise<ScmStatusCore> {
  invalidateStatus(dir);
  const result = await getStatus(dir);
  if (!result.ok) throw new Error(`status failed: ${result.error}`);
  return result.status;
}

const find = (entries: ScmEntry[], path: string): ScmEntry => {
  const entry = entries.find((e) => e.path === path);
  if (!entry) throw new Error(`no entry for ${path}: ${entries.map((e) => e.path).join(', ')}`);
  return entry;
};

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
/** A porcelain record list joined the way `-z` joins them: every field NUL-terminated. */
const z = (...fields: string[]): Buffer => Buffer.from(fields.map((f) => `${f}\x00`).join(''));

describe('parsePorcelainV2', () => {
  it('reads the branch headers', () => {
    const raw = parsePorcelainV2(
      z(
        '# branch.oid 2dc22f40d9017f8e47ee04dfdf8bbc4885506f1d',
        '# branch.head release/1.2.0',
        '# branch.upstream origin/release/1.2.0',
      ),
      100,
    );
    expect(raw).toMatchObject({
      head: '2dc22f40d9017f8e47ee04dfdf8bbc4885506f1d',
      branch: 'release/1.2.0',
      unborn: false,
      truncated: false,
    });
  });

  it('marks an unborn branch and leaves a detached HEAD without a branch', () => {
    const unborn = parsePorcelainV2(z('# branch.oid (initial)', '# branch.head main'), 100);
    expect(unborn.unborn).toBe(true);
    expect(unborn.head).toBeUndefined();
    expect(unborn.branch).toBe('main');
    const detached = parsePorcelainV2(z(`# branch.oid ${OID_A}`, '# branch.head (detached)'), 100);
    expect(detached.branch).toBeUndefined();
    expect(detached.head).toBe(OID_A);
  });

  it('splits an ordinary record by column and keeps spaces in the path', () => {
    const raw = parsePorcelainV2(
      z(
        `1 .M N... 100644 100644 100644 ${OID_A} ${OID_A} dir/with space.ts`,
        `1 A. N... 000000 100644 100644 ${ZERO} ${OID_B} added.ts`,
        `1 MM N... 100644 100644 100644 ${OID_A} ${OID_B} both.ts`,
        `1 .D N... 100644 100644 000000 ${OID_A} ${OID_A} gone.ts`,
        `1 T. N... 100644 120000 120000 ${OID_A} ${OID_B} typed.ts`,
      ),
      100,
    );
    expect(raw.changes.map((e) => [e.path, e.status])).toEqual([
      ['dir/with space.ts', 'M'],
      ['both.ts', 'M'],
      ['gone.ts', 'D'],
    ]);
    expect(raw.staged.map((e) => [e.path, e.status])).toEqual([
      ['added.ts', 'A'],
      ['both.ts', 'M'],
      ['typed.ts', 'T'],
    ]);
    expect(raw.staged[0]).toMatchObject({
      kind: 'ordinary',
      modes: ['000000', '100644', '100644'],
      oids: [ZERO, OID_B],
    });
  });

  it('keeps all three modes of a chmod-only change', () => {
    const raw = parsePorcelainV2(
      z(`1 .M N... 100644 100644 100755 ${OID_A} ${OID_A} run.sh`),
      100,
    );
    expect(raw.changes).toMatchObject([
      { path: 'run.sh', status: 'M', modes: ['100644', '100644', '100755'], oids: [OID_A, OID_A] },
    ]);
    expect(raw.staged).toEqual([]);
  });

  it('reads a rename with its old path and a rename that is also modified', () => {
    const raw = parsePorcelainV2(
      z(
        `2 R. N... 100644 100644 100644 ${OID_A} ${OID_A} R100 new.ts`,
        'old.ts',
        `2 RM N... 100644 100644 100644 ${OID_A} ${OID_B} R90 also new.ts`,
        'also old.ts',
      ),
      100,
    );
    expect(raw.staged).toMatchObject([
      { path: 'new.ts', oldPath: 'old.ts', kind: 'rename', status: 'R' },
      { path: 'also new.ts', oldPath: 'also old.ts', kind: 'rename', status: 'R' },
    ]);
    expect(raw.changes).toMatchObject([{ path: 'also new.ts', kind: 'ordinary', status: 'M' }]);
    expect(raw.changes[0]?.oldPath).toBeUndefined();
  });

  it('reads an unmerged record into merge with its three stages', () => {
    const raw = parsePorcelainV2(
      z(`u UU N... 100644 100644 100644 100644 ${OID_A} ${OID_B} ${ZERO} conflict.ts`),
      100,
    );
    expect(raw.merge).toEqual([
      {
        group: 'merge',
        path: 'conflict.ts',
        kind: 'unmerged',
        status: 'U',
        modes: ['100644', '100644', '100644', '100644'],
        oids: [OID_A, OID_B, ZERO],
      },
    ]);
    expect(raw.staged).toEqual([]);
    expect(raw.changes).toEqual([]);
  });

  it('reads untracked files individually', () => {
    const raw = parsePorcelainV2(z('? fresh/one.ts', '? fresh/two words.ts'), 100);
    expect(raw.changes.map((e) => [e.path, e.kind, e.status])).toEqual([
      ['fresh/one.ts', 'untracked', '?'],
      ['fresh/two words.ts', 'untracked', '?'],
    ]);
  });

  it('stops at the limit and says so', () => {
    const raw = parsePorcelainV2(z('? a', '? b', '? c', '? d'), 3);
    expect(raw.changes).toHaveLength(3);
    expect(raw.truncated).toBe(true);
    expect(parsePorcelainV2(z('? a', '? b', '? c'), 3).truncated).toBe(false);
  });

  it('drops the partial last record of output that was cut', () => {
    const cut = Buffer.from('? a\x00? b\x00? partia');
    const raw = parsePorcelainV2(cut, 100, true);
    expect(raw.changes.map((e) => e.path)).toEqual(['a', 'b']);
    expect(raw.truncated).toBe(true);
  });
});

describe('parseNumstat', () => {
  it('reads counts, binary files and a path holding tabs', () => {
    expect(parseNumstat(Buffer.from('3\t1\ta.ts\x00-\t-\tbin.dat\x000\t0\tweird\tname.ts\x00'))).toEqual([
      { path: 'a.ts', added: 3, removed: 1, binary: false },
      { path: 'bin.dat', binary: true },
      { path: 'weird\tname.ts', added: 0, removed: 0, binary: false },
    ]);
  });

  it('reads a rename record: an empty path field, then the old and new paths', () => {
    expect(
      parseNumstat(Buffer.from('1\t2\t\x00old name.ts\x00new name.ts\x005\t0\tnext.ts\x00')),
    ).toEqual([
      { path: 'new name.ts', added: 1, removed: 2, binary: false },
      { path: 'next.ts', added: 5, removed: 0, binary: false },
    ]);
  });

  it('is empty for no output', () => {
    expect(parseNumstat(Buffer.alloc(0))).toEqual([]);
  });
});

describe('getStatus on a repository holding every kind', () => {
  let dir: string;
  let status: ScmStatusCore;

  beforeAll(async () => {
    const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join('');
    dir = await makeRepo({
      '.gitignore': '*.log\n',
      'kept.txt': 'kept\n',
      'edit.txt': 'one\ntwo\nthree\n',
      'gone.txt': 'a\nb\n',
      'rename-me.txt': tenLines,
      'mode.sh': '#!/bin/sh\necho hi\n',
      'both.txt': 'x\n',
      'bin.dat': Buffer.from([0, 1, 2, 3]),
    });
    await put(dir, 'edit.txt', 'one\nTWO\nthree\n');
    await rm(join(dir, 'gone.txt'));
    await git(dir, 'mv', 'rename-me.txt', 'renamed.txt');
    await put(dir, 'renamed.txt', tenLines.replace('line 4', 'LINE 4'));
    await git(dir, 'add', 'renamed.txt');
    await chmod(join(dir, 'mode.sh'), 0o755);
    await put(dir, 'both.txt', 'x\ny\n');
    await git(dir, 'add', 'both.txt');
    await put(dir, 'both.txt', 'x\ny\nz\n');
    await put(dir, 'added.txt', 'new\n');
    await git(dir, 'add', 'added.txt');
    for (const n of [1, 2, 3]) await put(dir, `fresh/${n}.txt`, `${n}\n`);
    await put(dir, 'ignored.log', 'noise\n');
    await put(dir, 'bin.dat', Buffer.from([0, 9, 9, 9, 9]));
    status = await statusOf(dir);
  });

  it('answers the branch and head', () => {
    expect(status.top).toBe(dir);
    expect(status.branch).toBe('main');
    expect(status.head).toMatch(/^[0-9a-f]{40}$/);
    expect(status.unborn).toBe(false);
    expect(status.truncated).toBe(false);
    expect(status.merge).toEqual([]);
    expect(status.tookMs).toBeGreaterThanOrEqual(0);
    expect(status.attrEpoch).toMatch(/^[0-9a-f]{16}$/);
  });

  it('lists staged entries with status, line counts and a rename with its old path', () => {
    expect(status.staged.map((e) => e.path)).toEqual(['added.txt', 'both.txt', 'renamed.txt']);
    expect(find(status.staged, 'added.txt')).toMatchObject({ status: 'A', kind: 'ordinary', added: 1, removed: 0 });
    expect(find(status.staged, 'both.txt')).toMatchObject({ status: 'M', added: 1, removed: 0 });
    expect(find(status.staged, 'renamed.txt')).toMatchObject({
      status: 'R',
      kind: 'rename',
      oldPath: 'rename-me.txt',
      added: 1,
      removed: 1,
    });
  });

  it('lists work tree changes: modified, deleted, mode-only, binary, and a file also staged', () => {
    expect(find(status.changes, 'edit.txt')).toMatchObject({ status: 'M', added: 1, removed: 1 });
    expect(find(status.changes, 'gone.txt')).toMatchObject({ status: 'D', added: 0, removed: 2 });
    expect(find(status.changes, 'both.txt')).toMatchObject({ status: 'M', added: 1, removed: 0 });
    expect(find(status.changes, 'mode.sh')).toMatchObject({ status: 'M', added: 0, removed: 0 });
    const bin = find(status.changes, 'bin.dat');
    expect(bin.binary).toBe(true);
    expect(bin.added).toBeUndefined();
  });

  it('lists untracked files one by one without counts, and never an ignored file', () => {
    const untracked = status.changes.filter((e) => e.kind === 'untracked').map((e) => e.path);
    expect(untracked).toEqual(['fresh/1.txt', 'fresh/2.txt', 'fresh/3.txt']);
    const fresh = find(status.changes, 'fresh/1.txt');
    expect(fresh).toMatchObject({ status: '?', kind: 'untracked' });
    expect(fresh.added).toBeUndefined();
    expect(status.changes.some((e) => e.path === 'ignored.log')).toBe(false);
  });

  it('puts each group in path order', () => {
    for (const group of [status.staged, status.changes]) {
      const paths = group.map((e) => e.path);
      expect(paths).toEqual([...paths].toSorted());
    }
  });
});

describe('getStatus special repositories', () => {
  it('lists staged files as added before the first commit', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\nb\n', 'dir/b.ts': 'b\n' }, false);
    await git(dir, 'add', '-A');
    await put(dir, 'loose.ts', 'loose\n');
    const status = await statusOf(dir);
    expect(status.unborn).toBe(true);
    expect(status.head).toBeUndefined();
    expect(status.branch).toBe('main');
    expect(status.staged.map((e) => [e.path, e.status])).toEqual([
      ['a.ts', 'A'],
      ['dir/b.ts', 'A'],
    ]);
    expect(find(status.staged, 'a.ts')).toMatchObject({ added: 2, removed: 0 });
    expect(status.changes.map((e) => [e.path, e.kind])).toEqual([['loose.ts', 'untracked']]);
  });

  it('lists a conflicted file under merge, never under staged or changes', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\ntwo\nthree\n', 'quiet.ts': 'q\n' });
    await git(dir, 'checkout', '-q', '-b', 'other');
    await put(dir, 'a.ts', 'one\nOTHER\nthree\n');
    await git(dir, 'commit', '-qam', 'other');
    await git(dir, 'checkout', '-q', 'main');
    await put(dir, 'a.ts', 'one\nMAIN\nthree\n');
    await git(dir, 'commit', '-qam', 'main');
    await git(dir, 'merge', 'other').catch(() => undefined);

    const status = await statusOf(dir);
    expect(status.merge).toHaveLength(1);
    expect(status.merge[0]).toMatchObject({ path: 'a.ts', kind: 'unmerged', status: 'U' });
    expect(status.staged.some((e) => e.path === 'a.ts')).toBe(false);
    expect(status.changes.some((e) => e.path === 'a.ts')).toBe(false);
  });

  it('caps the list and says it was truncated', async () => {
    const dir = await makeRepo({ 'seed.txt': 's\n' });
    const total = STATUS_ENTRY_LIMIT + 1;
    for (let from = 0; from < total; from += 250) {
      await Promise.all(
        Array.from({ length: Math.min(250, total - from) }, (_, i) => put(dir, `many/f${from + i}.txt`, 'x\n')),
      );
    }
    const status = await statusOf(dir);
    expect(status.truncated).toBe(true);
    expect(status.changes).toHaveLength(STATUS_ENTRY_LIMIT);
  }, 60_000);

  it('lists an untracked nested repository as one directory entry, not as files', async () => {
    const dir = await makeRepo({ 'seed.txt': 's\n' });
    await put(dir, 'vendor/inner/x.txt', 'x\n');
    await git(join(dir, 'vendor', 'inner'), 'init', '-q');
    const status = await statusOf(dir);
    expect(status.changes.map((e) => [e.path, e.kind])).toEqual([['vendor/inner/', 'untracked']]);
  });

  it('refuses a directory that is not a repository', async () => {
    const plain = await tempDir();
    invalidateStatus(plain);
    const result = await getStatus(plain);
    expect(result.ok).toBe(false);
  });
});

describe('fingerprints', () => {
  it('stay put while nothing changes and move with a chmod', async () => {
    const dir = await makeRepo({ 'run.sh': 'echo\n', 'other.txt': 'o\n' });
    await put(dir, 'run.sh', 'echo changed\n');
    const first = find((await statusOf(dir)).changes, 'run.sh').fp;
    expect(find((await statusOf(dir)).changes, 'run.sh').fp).toBe(first);

    await chmod(join(dir, 'run.sh'), 0o755);
    expect(find((await statusOf(dir)).changes, 'run.sh').fp).not.toBe(first);
  });

  it('move with a same-size replacement that kept its mtime', async () => {
    const dir = await makeRepo({ 'a.txt': 'aaaa\n' });
    await put(dir, 'a.txt', 'bbbb\n');
    const before = await stat(join(dir, 'a.txt'));
    const first = find((await statusOf(dir)).changes, 'a.txt').fp;

    await new Promise((r) => setTimeout(r, 20));
    await put(dir, 'a.txt', 'cccc\n');
    await utimes(join(dir, 'a.txt'), before.atime, before.mtime);
    expect(find((await statusOf(dir)).changes, 'a.txt').fp).not.toBe(first);
  });

  it('move when an untracked file is replaced, and when a staged entry changes oid', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    await put(dir, 'new.txt', '1\n');
    const untracked = find((await statusOf(dir)).changes, 'new.txt').fp;
    await put(dir, 'new.txt', '22\n');
    expect(find((await statusOf(dir)).changes, 'new.txt').fp).not.toBe(untracked);

    await put(dir, 'a.txt', 'a2\n');
    await git(dir, 'add', 'a.txt');
    const staged = find((await statusOf(dir)).staged, 'a.txt').fp;
    await put(dir, 'a.txt', 'a3\n');
    await git(dir, 'add', 'a.txt');
    expect(find((await statusOf(dir)).staged, 'a.txt').fp).not.toBe(staged);
  });

  it('differ between the two groups for one file', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    await put(dir, 'a.txt', 'a2\n');
    await git(dir, 'add', 'a.txt');
    await put(dir, 'a.txt', 'a3\n');
    const status = await statusOf(dir);
    expect(find(status.staged, 'a.txt').fp).not.toBe(find(status.changes, 'a.txt').fp);
  });
});

describe('coalescing', () => {
  it('costs ten concurrent requests one status read', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    await put(dir, 'a.txt', 'a2\n');
    invalidateStatus(dir);
    const seen: string[] = [];
    setGitObserver((args) => seen.push(args[0] ?? ''));

    const results = await Promise.all(Array.from({ length: 10 }, () => getStatus(dir)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(seen.filter((c) => c === 'status')).toHaveLength(1);
    const oneRead = seen.length;
    // Ten callers received the one answer.
    expect(new Set(results.map((r) => (r.ok ? r.status : null))).size).toBe(1);

    // Inside the 500 ms window a later caller costs nothing either.
    await getStatus(dir);
    expect(seen).toHaveLength(oneRead);
  });

  it('reads again once the cache has expired, and at once after invalidateStatus', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    invalidateStatus(dir);
    const seen: string[] = [];
    setGitObserver((args) => seen.push(args[0] ?? ''));
    await getStatus(dir);
    await getStatus(dir);
    expect(seen.filter((c) => c === 'status')).toHaveLength(1);

    invalidateStatus(dir);
    await getStatus(dir);
    expect(seen.filter((c) => c === 'status')).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 600));
    await getStatus(dir);
    expect(seen.filter((c) => c === 'status')).toHaveLength(3);
  });

  it('never caches an answer that started before a write', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    invalidateStatus(dir);
    const stale = getStatus(dir);
    await put(dir, 'late.txt', 'late\n');
    invalidateStatus(dir);
    await stale;
    const fresh = await getStatus(dir);
    expect(fresh.ok && fresh.status.changes.some((e) => e.path === 'late.txt')).toBe(true);
  });

  it('keeps two repositories apart', async () => {
    const one = await makeRepo({ 'a.txt': 'a\n' });
    const two = await makeRepo({ 'b.txt': 'b\n' });
    await put(two, 'new.txt', 'n\n');
    const [first, second] = await Promise.all([statusOf(one), statusOf(two)]);
    expect(first.top).toBe(one);
    expect(first.changes).toEqual([]);
    expect(second.changes.map((e) => e.path)).toEqual(['new.txt']);
  });
});

describe('attrEpoch', () => {
  it('moves when a tracked .gitattributes is edited', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.txt text\n', 'a.txt': 'a\n' });
    const first = (await statusOf(dir)).attrEpoch;
    expect((await statusOf(dir)).attrEpoch).toBe(first);
    await put(dir, '.gitattributes', '*.txt text eol=crlf\n');
    expect((await statusOf(dir)).attrEpoch).not.toBe(first);
  });

  it('moves when an untracked .gitattributes appears, and again when it is deleted', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    const none = (await statusOf(dir)).attrEpoch;
    await put(dir, 'sub/.gitattributes', '*.txt -diff\n');
    const added = (await statusOf(dir)).attrEpoch;
    expect(added).not.toBe(none);
    await rm(join(dir, 'sub/.gitattributes'));
    const deleted = (await statusOf(dir)).attrEpoch;
    expect(deleted).not.toBe(added);
  });

  it('moves when a tracked .gitattributes is deleted from the work tree', async () => {
    const dir = await makeRepo({ '.gitattributes': 'yarn.lock -diff\n', 'yarn.lock': 'x\n' });
    const first = (await statusOf(dir)).attrEpoch;
    await rm(join(dir, '.gitattributes'));
    expect((await statusOf(dir)).attrEpoch).not.toBe(first);
  });

  it('moves with .git/info/attributes and with the repository config, and not with unrelated edits', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    const first = (await statusOf(dir)).attrEpoch;
    await put(dir, 'a.txt', 'a changed\n');
    await put(dir, 'unrelated.txt', 'u\n');
    expect((await statusOf(dir)).attrEpoch).toBe(first);

    await put(dir, '.git/info/attributes', '*.txt -diff\n');
    const info = (await statusOf(dir)).attrEpoch;
    expect(info).not.toBe(first);

    await git(dir, 'config', 'core.autocrlf', 'true');
    expect((await statusOf(dir)).attrEpoch).not.toBe(info);
  });

  it('moves with the global attributes file named by core.attributesFile', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    const attributes = join(await tempDir(), 'my-attributes');
    await writeFile(attributes, '*.txt text\n');
    await git(dir, 'config', 'core.attributesFile', attributes);
    const first = (await statusOf(dir)).attrEpoch;
    await writeFile(attributes, '*.txt -text\n');
    expect((await statusOf(dir)).attrEpoch).not.toBe(first);
  });

  it('never asks git for a glob pathspec', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.txt text\n', 'a.txt': 'a\n' });
    invalidateStatus(dir);
    const seen: (readonly string[])[] = [];
    setGitObserver((args) => seen.push(args));
    await getStatus(dir);
    expect(seen.flat().some((arg) => arg.includes(':(glob)') || arg.includes('*gitattributes'))).toBe(false);
  });
});

describe('reading status never interferes with the user git', () => {
  it('does not refresh the index the way a plain git status does', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    // A touched file has stale stat data, so a plain `git status` rewrites the index to refresh it.
    const future = new Date(Date.now() + 5000);
    await utimes(join(dir, 'a.txt'), future, future);
    const indexPath = join(dir, '.git', 'index');
    const before = await stat(indexPath);

    await statusOf(dir);
    const afterPalmux = await stat(indexPath);
    expect(afterPalmux.mtimeMs).toBe(before.mtimeMs);
    expect(afterPalmux.ino).toBe(before.ino);

    await git(dir, 'status', '--porcelain');
    const afterPlain = await stat(indexPath);
    expect(afterPlain.ino === before.ino && afterPlain.mtimeMs === before.mtimeMs).toBe(false);
  });

  it('lets git commit run while status requests loop, and no commit fails with index.lock', async () => {
    const dir = await makeRepo({ 'a.txt': '0\n', 'b.txt': 'b\n' });
    let stop = false;
    let reads = 0;
    const looper = (async () => {
      while (!stop) {
        invalidateStatus(dir);
        const result = await getStatus(dir);
        expect(result.ok).toBe(true);
        reads += 1;
      }
    })();
    const failures: string[] = [];
    try {
      for (let i = 1; i <= 25; i++) {
        await put(dir, 'a.txt', `${i}\n`);
        try {
          await git(dir, 'add', 'a.txt');
          await git(dir, 'commit', '-q', '-m', `c${i}`);
        } catch (e) {
          failures.push(String((e as { stderr?: string }).stderr ?? e));
        }
      }
    } finally {
      stop = true;
      await looper;
    }
    expect(failures).toEqual([]);
    expect(reads).toBeGreaterThan(5);
    expect((await git(dir, 'rev-list', '--count', 'HEAD')).trim()).toBe('26');
  }, 60_000);
});
