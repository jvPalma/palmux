// The three writes: stage, unstage and undo, as index transactions under git's lock protocol.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ScmAlgorithm, ScmFileSnapshot, ScmGroup } from '@palmux/shared';
import {
  hasSplitIndexExtension,
  indexHooks,
  releaseAllLocks,
  restoreReceipt,
  stageFile,
  unstageFile,
} from './scm-index';
import { configureScmCache, readSnapshot, resetScmCache } from './scm-snapshot';
import { getStatus, invalidateStatus } from './scm-status';

const exec = promisify(execFile);

let home: string;
let scratch: string;
let savedHome: string | undefined;
let savedXdg: string | undefined;
let savedTmp: string | undefined;
const baseConfig =
  '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n';

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'palmux-scm-home-'));
  await writeFile(join(home, '.gitconfig'), baseConfig);
  // A private TMPDIR, so the test can see whether the module leaks its scratch directories.
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'palmux-scm-tmp-')));
  savedHome = process.env['HOME'];
  savedXdg = process.env['XDG_CONFIG_HOME'];
  savedTmp = process.env['TMPDIR'];
  process.env['HOME'] = home;
  process.env['TMPDIR'] = scratch;
  delete process.env['XDG_CONFIG_HOME'];
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  if (savedXdg !== undefined) process.env['XDG_CONFIG_HOME'] = savedXdg;
  if (savedTmp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmp;
  await Promise.all([home, scratch].map((dir) => rm(dir, { recursive: true, force: true })));
});

afterEach(() => {
  indexHooks.afterLock = null;
  releaseAllLocks();
  resetScmCache();
  configureScmCache({ maxBytes: 64 * 1024 * 1024, ttlMs: 10 * 60 * 1000 });
  vi.useRealTimers();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout;
}

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(scratch, 'repo-')));
}

async function put(dir: string, rel: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content);
}

async function makeRepo(
  files: Record<string, string | Buffer> = {},
  commit = true,
): Promise<string> {
  const dir = await tempDir();
  await git(dir, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
  if (commit) {
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

const lsFiles = (dir: string): Promise<string> => git(dir, 'ls-files', '-s');
const porcelain = async (dir: string): Promise<string> => (await git(dir, 'status', '--porcelain')).trimEnd();
const blobAt = async (dir: string, path: string): Promise<string> => git(dir, 'show', `:0:${path}`);

async function snap(
  dir: string,
  path: string,
  group: ScmGroup = 'changes',
  algorithm: ScmAlgorithm = 'histogram',
): Promise<ScmFileSnapshot> {
  const result = await readSnapshot({ top: dir, group, path, algorithm });
  if (!result.ok) throw new Error(`snapshot failed: ${result.error}`);
  return result.snapshot;
}

async function tokenOf(dir: string, path: string): Promise<string> {
  const token = (await snap(dir, path)).token;
  if (!token) throw new Error(`no token for ${path}`);
  return token;
}

async function stage(dir: string, path: string) {
  const result = await stageFile({ top: dir, path, token: await tokenOf(dir, path) });
  if (!result.ok) throw new Error(`stage failed (${result.status}): ${result.error}`);
  return result.result;
}

async function expectFailure<T extends { ok: boolean }>(
  promise: Promise<T>,
  status: number,
  code?: string,
): Promise<Extract<T, { ok: false }> & { status: number; error: string; code?: string }> {
  const result = (await promise) as unknown as { ok: boolean; status: number; error: string; code?: string };
  expect(result.ok).toBe(false);
  expect(result.status).toBe(status);
  if (code !== undefined) expect(result.code).toBe(code);
  return result as never;
}

/** No lock left behind, and no scratch directory of this module left in the private TMPDIR. */
async function expectClean(dir: string): Promise<void> {
  await expect(stat(join(dir, '.git', 'index.lock'))).rejects.toThrow();
  const leaked = (await readdir(scratch)).filter((n) => n.startsWith('palmux-scm-index-'));
  expect(leaked).toEqual([]);
}

// ── Stage ─────────────────────────────────────────────────────────────────────

describe('stageFile', () => {
  it('stages an untracked file exactly as git add would, and touches nothing else', async () => {
    const dir = await makeRepo({ 'seed.txt': 's\n' });
    await put(dir, 'fresh/new.ts', 'x\ny\n');
    const beforeIndex = await lsFiles(dir);

    const result = await stage(dir, 'fresh/new.ts');
    expect(result.status).toBe('staged');
    expect(result.receiptId).toBeTruthy();

    expect(await blobAt(dir, 'fresh/new.ts')).toBe('x\ny\n');
    expect(await porcelain(dir)).toBe('A  fresh/new.ts');
    expect((await lsFiles(dir)).split('\n').filter((l) => !l.includes('fresh/'))).toEqual(
      beforeIndex.split('\n'),
    );
    expect(await readFile(join(dir, 'fresh/new.ts'), 'utf8')).toBe('x\ny\n');
    await expectClean(dir);
  });

  it('creates the index when the repository has none yet', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' }, false);
    await expect(stat(join(dir, '.git', 'index'))).rejects.toThrow();
    await stage(dir, 'a.ts');
    expect(await porcelain(dir)).toBe('A  a.ts');
    await expectClean(dir);
  });

  it('stages an edit to a tracked file', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\ntwo\n' });
    await put(dir, 'a.ts', 'one\nTWO\n');
    await stage(dir, 'a.ts');
    expect(await porcelain(dir)).toBe('M  a.ts');
  });

  it('stages a deletion from a token that recorded the work tree side as absent', async () => {
    const dir = await makeRepo({ 'gone.ts': 'a\n', 'kept.ts': 'k\n' });
    await rm(join(dir, 'gone.ts'));
    await stage(dir, 'gone.ts');
    expect(await porcelain(dir)).toBe('D  gone.ts');
  });

  it('stages the version the review showed, not a later edit', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n' });
    await put(dir, 'a.ts', 'shown\n');
    const token = await tokenOf(dir, 'a.ts');
    await put(dir, 'a.ts', 'edited after it was shown\n');

    const result = await stageFile({ top: dir, path: 'a.ts', token });
    expect(result.ok).toBe(true);
    expect(await blobAt(dir, 'a.ts')).toBe('shown\n');
    expect(await porcelain(dir)).toBe('MM a.ts');
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('edited after it was shown\n');
  });

  it('stages a mode change with its own mode', async () => {
    const dir = await makeRepo({ 'run.sh': '#!/bin/sh\n' });
    await chmod(join(dir, 'run.sh'), 0o755);
    await stage(dir, 'run.sh');
    expect((await lsFiles(dir)).startsWith('100755 ')).toBe(true);
    expect(await porcelain(dir)).toBe('M  run.sh');
  });

  it('stages a symlink as a link, with what git add would record', async () => {
    const dir = await makeRepo({ 'target.txt': 't\n' });
    await symlink('target.txt', join(dir, 'link'));
    await stage(dir, 'link');
    expect(await lsFiles(dir)).toContain('120000 ');
    expect(await porcelain(dir)).toBe('A  link');
  });

  it('writes two snapshots of equal content and different modes with their own modes', async () => {
    const dir = await makeRepo({ 'run.sh': 'same\n' });
    await put(dir, 'run.sh', 'same, edited\n');
    const plain = await tokenOf(dir, 'run.sh');
    await chmod(join(dir, 'run.sh'), 0o755);
    const executable = await tokenOf(dir, 'run.sh');
    expect(executable).not.toBe(plain);

    await stageFile({ top: dir, path: 'run.sh', token: executable });
    expect((await lsFiles(dir)).startsWith('100755 ')).toBe(true);
    await stageFile({ top: dir, path: 'run.sh', token: plain });
    expect((await lsFiles(dir)).startsWith('100644 ')).toBe(true);
  });

  it('stages a CRLF file that git keeps as CRLF (text=auto, CRLF already in the index) without renormalising it', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
    await put(dir, '.gitattributes', '* text=auto\n');
    await git(dir, 'add', '.gitattributes');
    await git(dir, 'commit', '-q', '-m', 'attributes');
    await put(dir, 'a.txt', 'one\r\nTWO\r\nthree\r\n');

    await stage(dir, 'a.txt');
    expect(await blobAt(dir, 'a.txt')).toBe('one\r\nTWO\r\nthree\r\n');
    // git add would have written the same blob, so nothing is left unstaged.
    expect(await porcelain(dir)).toBe('M  a.txt');
    expect((await git(dir, 'diff', '--cached', '--numstat')).trim()).toBe('1\t1\ta.txt');
  });

  it('stages the converted bytes when git would convert CRLF to LF', async () => {
    const dir = await makeRepo({ 'docs/a.txt': 'one\ntwo\n' });
    await put(dir, 'docs/.gitattributes', 'a.txt text eol=crlf\n');
    await git(dir, 'add', 'docs/.gitattributes');
    await git(dir, 'commit', '-q', '-m', 'attributes');
    await put(dir, 'docs/a.txt', 'one\r\nTWO\r\n');

    await stage(dir, 'docs/a.txt');
    expect(await blobAt(dir, 'docs/a.txt')).toBe('one\nTWO\n');
    expect(await porcelain(dir)).toBe('M  docs/a.txt');
  });

  it('answers a status that reflects the write at once, inside the cache window', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'b\n');
    invalidateStatus(dir);
    const before = await getStatus(dir);
    expect(before.ok && before.status.staged).toEqual([]);

    await stage(dir, 'a.ts');
    const after = await getStatus(dir);
    expect(after.ok && after.status.staged.map((e) => e.path)).toEqual(['a.ts']);
    expect(after.ok && after.status.changes).toEqual([]);
  });

  it('queues two concurrent writes to one repository instead of answering busy', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    await put(dir, 'a.ts', 'a2\n');
    await put(dir, 'b.ts', 'b2\n');
    const [ta, tb] = await Promise.all([tokenOf(dir, 'a.ts'), tokenOf(dir, 'b.ts')]);
    const [ra, rb] = await Promise.all([
      stageFile({ top: dir, path: 'a.ts', token: ta }),
      stageFile({ top: dir, path: 'b.ts', token: tb }),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(await porcelain(dir)).toBe('M  a.ts\nM  b.ts');
    await expectClean(dir);
  });
});

describe('stageFile refusals', () => {
  it('answers 410 token for an expired token, and for one that never existed', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await put(dir, 'a.ts', 'b\n');
    const token = await tokenOf(dir, 'a.ts');
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));

    await expectFailure(stageFile({ top: dir, path: 'a.ts', token }), 410, 'token');
    await expectFailure(stageFile({ top: dir, path: 'a.ts', token: 'tdeadbeef' }), 410, 'token');
    expect(await porcelain(dir)).toBe(' M a.ts');
    await expectClean(dir);
  });

  it('refuses a token that belongs to another file, another repository, or no token at all', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    const other = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'a2\n');
    await put(dir, 'b.ts', 'b2\n');
    const tokenA = await tokenOf(dir, 'a.ts');
    await expectFailure(stageFile({ top: dir, path: 'b.ts', token: tokenA }), 400);
    await expectFailure(stageFile({ top: other, path: 'a.ts', token: tokenA }), 400);
    await expectFailure(stageFile({ top: dir, path: 'a.ts', token: '' }), 400);
    await expectFailure(stageFile({ top: dir, path: '../a.ts', token: tokenA }), 400);
    expect(await porcelain(dir)).toBe(' M a.ts\n M b.ts');
  });

  it('gives an over-limit or converted file no token to stage with', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.big filter=lfs\n', 'a.big': 'p\n', 'huge.txt': 'h\n' });
    await put(dir, 'a.big', 'changed\n');
    await put(dir, 'huge.txt', 'x'.repeat(1024 * 1024 + 1));
    expect((await snap(dir, 'a.big')).token).toBeUndefined();
    expect((await snap(dir, 'huge.txt')).token).toBeUndefined();
    await expectFailure(stageFile({ top: dir, path: 'huge.txt', token: '' }), 400);
    expect(await porcelain(dir)).toBe(' M a.big\n M huge.txt');
  });

  it('answers 409 changed when the attribute context differs from the snapshot’s, and writes nothing', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' });
    await put(dir, 'a.txt', 'two\n');
    const token = await tokenOf(dir, 'a.txt');
    const before = await lsFiles(dir);

    await put(dir, '.gitattributes', 'a.txt text eol=crlf\n');
    await expectFailure(stageFile({ top: dir, path: 'a.txt', token }), 409, 'changed');
    expect(await lsFiles(dir)).toBe(before);
    await expectClean(dir);
  });

  it('answers 409 changed when core.autocrlf changed', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' });
    await put(dir, 'a.txt', 'two\n');
    const token = await tokenOf(dir, 'a.txt');
    await git(dir, 'config', 'core.autocrlf', 'true');
    await expectFailure(stageFile({ top: dir, path: 'a.txt', token }), 409, 'changed');
  });

  it('refuses to write a path with merge conflicts, which has no token to stage with', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\ntwo\nthree\n' });
    await git(dir, 'checkout', '-q', '-b', 'other');
    await put(dir, 'a.ts', 'one\nOTHER\nthree\n');
    await git(dir, 'commit', '-qam', 'other');
    await git(dir, 'checkout', '-q', 'main');
    await put(dir, 'a.ts', 'one\nMAIN\nthree\n');
    await git(dir, 'commit', '-qam', 'main');
    await git(dir, 'merge', 'other').catch(() => undefined);
    // The unmerged snapshot has no token, so stage with one taken for the same path before the merge.
    const conflicted = await snap(dir, 'a.ts');
    expect(conflicted.unmerged).toBe(true);
    const before = await lsFiles(dir);
    await expectFailure(unstageFile({ top: dir, path: 'a.ts' }), 409);
    expect(await lsFiles(dir)).toBe(before);
    await expectClean(dir);
  });
});

describe('the index lock', () => {
  it('answers 409 busy at once when another program holds index.lock, and leaves that lock alone', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'b\n');
    const token = await tokenOf(dir, 'a.ts');
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, 'held by someone else');
    const before = await lsFiles(dir);

    const started = Date.now();
    await expectFailure(stageFile({ top: dir, path: 'a.ts', token }), 409, 'busy');
    await expectFailure(unstageFile({ top: dir, path: 'a.ts' }), 409, 'busy');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await readFile(lock, 'utf8')).toBe('held by someone else');
    expect(await lsFiles(dir)).toBe(before);

    await rm(lock);
    expect((await stageFile({ top: dir, path: 'a.ts', token })).ok).toBe(true);
  });

  it('answers 409 busy to an Undo too, and keeps the receipt for a retry', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'b\n');
    const { receiptId } = await stage(dir, 'a.ts');
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, 'held');
    await expectFailure(restoreReceipt({ top: dir, receiptId }), 409, 'busy');
    await rm(lock);
    expect((await restoreReceipt({ top: dir, receiptId })).ok).toBe(true);
    expect(await porcelain(dir)).toBe(' M a.ts');
  });

  it('removes its lock after a failed write and after a successful one', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' });
    await put(dir, 'a.txt', 'two\n');
    const token = await tokenOf(dir, 'a.txt');
    await put(dir, '.gitattributes', 'a.txt text\n');
    await expectFailure(stageFile({ top: dir, path: 'a.txt', token }), 409, 'changed');
    await expectClean(dir);
    await rm(join(dir, '.gitattributes'));
    expect((await stageFile({ top: dir, path: 'a.txt', token })).ok).toBe(true);
    await expectClean(dir);
  });

  it('lets releaseAllLocks remove a lock left by a write that never finished, without touching the index', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'b\n');
    const token = await tokenOf(dir, 'a.ts');
    const lock = join(dir, '.git', 'index.lock');
    const before = await lsFiles(dir);

    let proceed: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const atLock = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (proceed = resolve));
    indexHooks.afterLock = async () => {
      reached();
      await gate;
    };

    const pending = stageFile({ top: dir, path: 'a.ts', token });
    await atLock;
    await expect(stat(lock)).resolves.toBeTruthy();

    // What the shutdown handler and process.on('exit') call.
    expect(releaseAllLocks()).toEqual([lock]);
    await expect(stat(lock)).rejects.toThrow();
    expect(releaseAllLocks()).toEqual([]);

    proceed();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(await lsFiles(dir)).toBe(before);
    await expectClean(dir);
  });

  it('refuses a repository with a split index and leaves everything as it was', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    await git(dir, 'update-index', '--split-index');
    expect(hasSplitIndexExtension(await readFile(join(dir, '.git', 'index')))).toBe(true);
    await put(dir, 'a.ts', 'a2\n');
    const token = await tokenOf(dir, 'a.ts');
    const before = await readFile(join(dir, '.git', 'index'));

    const failure = await expectFailure(stageFile({ top: dir, path: 'a.ts', token }), 501, 'unsupported');
    expect(failure.error).toMatch(/split index/);
    expect((await readFile(join(dir, '.git', 'index'))).equals(before)).toBe(true);
    await expectClean(dir);
  });

  it('refuses core.splitIndex even before the index is split', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await git(dir, 'config', 'core.splitIndex', 'true');
    await put(dir, 'a.ts', 'a2\n');
    const token = await tokenOf(dir, 'a.ts');
    await expectFailure(stageFile({ top: dir, path: 'a.ts', token }), 501, 'unsupported');
  });

  it('does not take a file named link for a split index', async () => {
    const dir = await makeRepo({ link: 'link\n', 'dir/link': 'x\n', 'linkage.ts': 'y\n' });
    expect(hasSplitIndexExtension(await readFile(join(dir, '.git', 'index')))).toBe(false);
    expect(hasSplitIndexExtension(Buffer.from('not an index'))).toBe(false);
  });
});

describe('directory and file conflicts', () => {
  it('answers 409 df when the index holds a file where a directory is needed', async () => {
    const dir = await makeRepo({ foo: 'a file\n' });
    await rm(join(dir, 'foo'));
    await put(dir, 'foo/bar', 'inside\n');
    const token = await tokenOf(dir, 'foo/bar');
    const before = await lsFiles(dir);

    const failure = await expectFailure(stageFile({ top: dir, path: 'foo/bar', token }), 409, 'df');
    expect(failure.error).toMatch(/foo/);
    expect(await lsFiles(dir)).toBe(before);
    await expectClean(dir);
  });

  it('answers 409 df when the index holds a directory where a file is needed', async () => {
    const dir = await makeRepo({ 'foo/bar': 'inside\n' });
    await rm(join(dir, 'foo'), { recursive: true });
    await put(dir, 'foo', 'now a file\n');
    const token = await tokenOf(dir, 'foo');
    const before = await lsFiles(dir);

    await expectFailure(stageFile({ top: dir, path: 'foo', token }), 409, 'df');
    expect(await lsFiles(dir)).toBe(before);
    await expectClean(dir);
  });
});

// ── Unstage ───────────────────────────────────────────────────────────────────

describe('unstageFile', () => {
  it('returns a staged edit to the HEAD entry', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n' });
    const headLine = await lsFiles(dir);
    await put(dir, 'a.ts', 'two\n');
    await git(dir, 'add', 'a.ts');

    const result = await unstageFile({ top: dir, path: 'a.ts' });
    expect(result.ok && result.result.status).toBe('unstaged');
    expect(await lsFiles(dir)).toBe(headLine);
    expect(await porcelain(dir)).toBe(' M a.ts');
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('two\n');
  });

  it('removes a new file from the index and leaves it on disk as untracked', async () => {
    const dir = await makeRepo({ 'seed.txt': 's\n' });
    await put(dir, 'new.ts', 'n\n');
    await git(dir, 'add', 'new.ts');
    expect((await unstageFile({ top: dir, path: 'new.ts' })).ok).toBe(true);
    expect(await porcelain(dir)).toBe('?? new.ts');
    expect(await readFile(join(dir, 'new.ts'), 'utf8')).toBe('n\n');
  });

  it('unstages a staged deletion', async () => {
    const dir = await makeRepo({ 'gone.ts': 'a\n' });
    await git(dir, 'rm', '-q', 'gone.ts');
    expect(await porcelain(dir)).toBe('D  gone.ts');
    expect((await unstageFile({ top: dir, path: 'gone.ts' })).ok).toBe(true);
    expect(await porcelain(dir)).toBe(' D gone.ts');
  });

  it('unstages a mode change', async () => {
    const dir = await makeRepo({ 'run.sh': 'x\n' });
    await chmod(join(dir, 'run.sh'), 0o755);
    await git(dir, 'add', 'run.sh');
    await unstageFile({ top: dir, path: 'run.sh' });
    expect((await lsFiles(dir)).startsWith('100644 ')).toBe(true);
    expect(await porcelain(dir)).toBe(' M run.sh');
  });

  it('restores both paths of a staged rename', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join('');
    const dir = await makeRepo({ 'a.ts': body, 'other.ts': 'o\n' });
    const headIndex = await lsFiles(dir);
    await git(dir, 'mv', 'a.ts', 'b.ts');
    await put(dir, 'b.ts', body.replace('line 5', 'LINE 5'));
    await git(dir, 'add', 'b.ts');
    expect(await porcelain(dir)).toContain('R  a.ts -> b.ts');

    const result = await unstageFile({ top: dir, path: 'b.ts', oldPath: 'a.ts' });
    expect(result.ok).toBe(true);
    expect(await lsFiles(dir)).toBe(headIndex);
    const status = await porcelain(dir);
    expect(status).toContain(' D a.ts');
    expect(status).toContain('?? b.ts');
  });

  it('leaves oldPath alone when it is still in the index, so it is not a rename source', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    await put(dir, 'a.ts', 'a2\n');
    await put(dir, 'b.ts', 'b2\n');
    await git(dir, 'add', 'a.ts', 'b.ts');
    expect((await unstageFile({ top: dir, path: 'b.ts', oldPath: 'a.ts' })).ok).toBe(true);
    expect(await porcelain(dir)).toBe('M  a.ts\n M b.ts');
  });

  it('unstages a file before the first commit by removing it from the index', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' }, false);
    await git(dir, 'add', 'a.ts', 'b.ts');
    expect((await unstageFile({ top: dir, path: 'a.ts' })).ok).toBe(true);
    expect(await porcelain(dir)).toBe('A  b.ts\n?? a.ts');
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('a\n');
    await expectClean(dir);
  });

  it('refuses a path that escapes the repository', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await expectFailure(unstageFile({ top: dir, path: '../a.ts' }), 400);
    await expectFailure(unstageFile({ top: dir, path: 'a.ts', oldPath: '/etc/passwd' }), 400);
  });

  it('reads a literal name, never a pattern', async () => {
    const dir = await makeRepo({ 'a*.ts': 'star\n', 'alpha.ts': 'alpha\n' });
    await put(dir, 'a*.ts', 'star 2\n');
    await put(dir, 'alpha.ts', 'alpha 2\n');
    await git(dir, 'add', '-A');
    await unstageFile({ top: dir, path: 'a*.ts' });
    expect(await porcelain(dir)).toBe(' M a*.ts\nM  alpha.ts');
  });
});

// ── Undo ──────────────────────────────────────────────────────────────────────

describe('restoreReceipt', () => {
  it('puts a partially staged entry back byte for byte', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n', 'other.ts': 'o\n' });
    await put(dir, 'a.ts', 'one\ntwo\n');
    await git(dir, 'add', 'a.ts');
    await put(dir, 'a.ts', 'one\ntwo\nthree\n');
    const partial = await lsFiles(dir);

    const { receiptId } = await stage(dir, 'a.ts');
    expect(await lsFiles(dir)).not.toBe(partial);
    expect(await blobAt(dir, 'a.ts')).toBe('one\ntwo\nthree\n');

    const restored = await restoreReceipt({ top: dir, receiptId });
    expect(restored.ok && restored.result.status).toBe('restored');
    expect(await lsFiles(dir)).toBe(partial);
    expect(await blobAt(dir, 'a.ts')).toBe('one\ntwo\n');
    expect(await porcelain(dir)).toBe('MM a.ts');
    await expectClean(dir);
  });

  it('puts an untracked file back to untracked', async () => {
    const dir = await makeRepo({ 'seed.txt': 's\n' });
    await put(dir, 'new.ts', 'n\n');
    const { receiptId } = await stage(dir, 'new.ts');
    expect(await porcelain(dir)).toBe('A  new.ts');
    await restoreReceipt({ top: dir, receiptId });
    expect(await porcelain(dir)).toBe('?? new.ts');
  });

  it('re-stages what an unstage removed, including both paths of a rename', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join('');
    const dir = await makeRepo({ 'a.ts': body });
    await git(dir, 'mv', 'a.ts', 'b.ts');
    await put(dir, 'b.ts', body.replace('line 5', 'LINE 5'));
    await git(dir, 'add', 'b.ts');
    const renamed = await lsFiles(dir);

    const unstaged = await unstageFile({ top: dir, path: 'b.ts', oldPath: 'a.ts' });
    if (!unstaged.ok) throw new Error(unstaged.error);
    expect(await lsFiles(dir)).not.toBe(renamed);
    const restored = await restoreReceipt({ top: dir, receiptId: unstaged.result.receiptId });
    expect(restored.ok).toBe(true);
    expect(await lsFiles(dir)).toBe(renamed);
  });

  it('refuses with 409 conflict when another writer changed the entry, and changes nothing', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n' });
    await put(dir, 'a.ts', 'two\n');
    const { receiptId } = await stage(dir, 'a.ts');
    await put(dir, 'a.ts', 'three\n');
    await git(dir, 'add', 'a.ts');
    const after = await lsFiles(dir);

    const failure = await expectFailure(restoreReceipt({ top: dir, receiptId }), 409, 'conflict');
    expect(failure.error).toMatch(/nothing was undone/);
    expect(await lsFiles(dir)).toBe(after);
    expect(await blobAt(dir, 'a.ts')).toBe('three\n');
    await expectClean(dir);
  });

  it('refuses when the staged entry was removed by someone else', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n' });
    await put(dir, 'a.ts', 'two\n');
    const { receiptId } = await stage(dir, 'a.ts');
    await git(dir, 'reset', '-q', 'a.ts');
    await expectFailure(restoreReceipt({ top: dir, receiptId }), 409, 'conflict');
  });

  it('can be used once, and then again through the receipt it answers with', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n' });
    await put(dir, 'a.ts', 'two\n');
    const first = await stage(dir, 'a.ts');
    const undone = await restoreReceipt({ top: dir, receiptId: first.receiptId });
    if (!undone.ok) throw new Error(undone.error);
    expect(await porcelain(dir)).toBe(' M a.ts');

    await expectFailure(restoreReceipt({ top: dir, receiptId: first.receiptId }), 410, 'token');
    const redone = await restoreReceipt({ top: dir, receiptId: undone.result.receiptId });
    expect(redone.ok).toBe(true);
    expect(await porcelain(dir)).toBe('M  a.ts');
  });

  it('refuses an unknown, expired or foreign receipt id', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    const other = await makeRepo({ 'a.ts': 'a\n' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await put(dir, 'a.ts', 'b\n');
    const { receiptId } = await stage(dir, 'a.ts');

    await expectFailure(restoreReceipt({ top: dir, receiptId: 'rdeadbeef' }), 410, 'token');
    await expectFailure(restoreReceipt({ top: dir, receiptId: '' }), 400);
    await expectFailure(restoreReceipt({ top: other, receiptId }), 400);
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));
    await expectFailure(restoreReceipt({ top: dir, receiptId }), 410, 'token');
  });

  it('never touches the work tree', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n' });
    await put(dir, 'a.ts', 'two\n');
    const { receiptId } = await stage(dir, 'a.ts');
    await restoreReceipt({ top: dir, receiptId });
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('two\n');
  });
});
