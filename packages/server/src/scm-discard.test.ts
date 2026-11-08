// Discards: palmux's one work tree write, its backups, and its Undo, in throwaway
// repositories. Every discard here also checks that the index is untouched.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ScmBatchResult } from '@palmux/shared';
import {
  DISCARD_RECEIPT_MAX,
  DISCARD_RECEIPT_MS,
  discardHooks,
  discardPaths,
  resetDiscardReceipts,
  restoreDiscard,
} from './scm-discard';
import { setGitObserver } from './scm-git';
import { configureScmCache, getReceipt, putReceipt, resetScmCache, scmCacheStats, walkHooks } from './scm-snapshot';
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
  discardHooks.afterStatus = null;
  discardHooks.beforeWrite = null;
  discardHooks.afterCompare = null;
  walkHooks.onStep = null;
  setGitObserver(null);
  resetDiscardReceipts();
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

async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  return git(cwd, ...args).then(
    () => true,
    () => false,
  );
}

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(scratch, 'repo-')));
}

async function put(dir: string, rel: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content);
}

async function makeRepo(files: Record<string, string | Buffer> = {}): Promise<string> {
  const dir = await tempDir();
  await git(dir, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

const read = (dir: string, rel: string): Promise<string> => readFile(join(dir, rel), 'utf8');

/** The entries the list would send: each path with the fp the status shows now. */
async function listed(dir: string, paths: readonly string[]): Promise<{ path: string; fp: string }[]> {
  invalidateStatus(dir);
  const status = await getStatus(dir);
  if (!status.ok) throw new Error(status.error);
  return paths.map((path) => ({ path, fp: status.status.changes.find((e) => e.path === path)?.fp ?? 'unlisted' }));
}

/** A discard that must succeed, and must leave the index's bytes and `git diff --cached` exactly as they were. */
async function discard(dir: string, paths: readonly string[]): Promise<ScmBatchResult> {
  const entries = await listed(dir, paths);
  const indexBefore = await readFile(join(dir, '.git/index'));
  const cachedBefore = await git(dir, 'diff', '--cached');
  const result = await discardPaths({ top: dir, entries });
  if (!result.ok) throw new Error(`discard failed (${result.status}): ${result.error}`);
  expect((await readFile(join(dir, '.git/index'))).equals(indexBefore)).toBe(true);
  expect(await git(dir, 'diff', '--cached')).toBe(cachedBefore);
  return result.result;
}

async function undo(dir: string, receiptId: string | null) {
  if (receiptId === null) throw new Error('the discard answered no receipt');
  return restoreDiscard({ top: dir, receiptId });
}

describe('discardPaths', () => {
  it('brings a tracked file back to its index version and keeps the staged change', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n', 'b.ts': 'b\n' });
    await put(dir, 'a.ts', 'two\n');
    await git(dir, 'add', 'a.ts');
    await put(dir, 'a.ts', 'three\n');

    const result = await discard(dir, ['a.ts']);
    expect(result).toMatchObject({ status: 'discarded', done: ['a.ts'], skipped: [] });
    expect(result.receiptId).toMatch(/^d[0-9a-f]{32}$/);
    expect(await read(dir, 'a.ts')).toBe('two\n');
    expect(await git(dir, 'status', '--porcelain')).toBe('M  a.ts\n');
  });

  it('brings back a file deleted from the work tree', async () => {
    const dir = await makeRepo({ 'gone/b.ts': 'b\n' });
    await rm(join(dir, 'gone'), { recursive: true });
    const result = await discard(dir, ['gone/b.ts']);
    expect(result.done).toEqual(['gone/b.ts']);
    expect(await read(dir, 'gone/b.ts')).toBe('b\n');
  });

  it('deletes an untracked folder and every folder it empties, and keeps a folder that holds an ignored file', async () => {
    const dir = await makeRepo({ '.gitignore': '*.log\n', 'seed.txt': 's\n' });
    for (const name of ['a', 'b', 'c']) await put(dir, `tmp/out/${name}.txt`, `${name}\n`);
    await put(dir, 'build/out/x.txt', 'x\n');
    await put(dir, 'build/cache.log', 'ignored\n');
    await put(dir, 'logs/run.log', 'ignored\n');

    const paths = ['tmp/out/a.txt', 'tmp/out/b.txt', 'tmp/out/c.txt', 'build/out/x.txt'];
    const result = await discard(dir, paths);
    expect(result.done).toEqual(paths);
    expect(await exists(join(dir, 'tmp'))).toBe(false);
    expect(await exists(join(dir, 'build/out'))).toBe(false);
    expect(await read(dir, 'build/cache.log')).toBe('ignored\n');
    expect(await read(dir, 'logs/run.log')).toBe('ignored\n');
    expect(await read(dir, 'seed.txt')).toBe('s\n');
  });

  it('takes a name with pattern characters literally', async () => {
    const dir = await makeRepo({ 'a*.ts': 'star\n', 'alpha.ts': 'alpha\n' });
    await put(dir, 'a*.ts', 'star 2\n');
    await put(dir, 'alpha.ts', 'alpha 2\n');
    expect((await discard(dir, ['a*.ts'])).done).toEqual(['a*.ts']);
    expect(await read(dir, 'a*.ts')).toBe('star\n');
    expect(await read(dir, 'alpha.ts')).toBe('alpha 2\n');
  });

  it('skips an entry whose fp no longer matches, and discards the rest', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    await put(dir, 'a.ts', 'a 2\n');
    await put(dir, 'b.ts', 'b 2\n');
    const entries = await listed(dir, ['a.ts', 'b.ts']);
    await put(dir, 'a.ts', 'a 3, written after the confirm\n');

    const result = await discardPaths({ top: dir, entries });
    if (!result.ok) throw new Error(result.error);
    expect(result.result.done).toEqual(['b.ts']);
    expect(result.result.skipped).toEqual([{ path: 'a.ts', reason: 'changed' }]);
    expect(await read(dir, 'a.ts')).toBe('a 3, written after the confirm\n');
    expect(await read(dir, 'b.ts')).toBe('b\n');
  });

  it('skips a file written after the status was read, which the fingerprint check could not see', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    await put(dir, 'a.ts', 'a 2\n');
    await put(dir, 'b.ts', 'b 2\n');
    await put(dir, 'new.txt', 'new\n');
    discardHooks.afterStatus = async () => {
      await put(dir, 'a.ts', 'a 3, written after the status\n');
      await put(dir, 'new.txt', 'new 2, written after the status\n');
    };

    const result = await discard(dir, ['a.ts', 'b.ts', 'new.txt']);
    expect(result.done).toEqual(['b.ts']);
    expect(result.skipped).toEqual([
      { path: 'a.ts', reason: 'changed' },
      { path: 'new.txt', reason: 'changed' },
    ]);
    expect(await read(dir, 'a.ts')).toBe('a 3, written after the status\n');
    expect(await read(dir, 'new.txt')).toBe('new 2, written after the status\n');
  });

  it('skips a file rewritten after its backup, tracked or untracked', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    await put(dir, 'a.ts', 'a 2\n');
    await put(dir, 'b.ts', 'b 2\n');
    await put(dir, 'new.txt', 'new\n');
    discardHooks.beforeWrite = async () => {
      await put(dir, 'a.ts', 'a 3, an agent wrote this\n');
      await put(dir, 'new.txt', 'new 2, an agent wrote this\n');
    };

    const result = await discard(dir, ['a.ts', 'b.ts', 'new.txt']);
    expect(result.done).toEqual(['b.ts']);
    expect(result.skipped).toEqual([
      { path: 'a.ts', reason: 'changed' },
      { path: 'new.txt', reason: 'changed' },
    ]);
    expect(await read(dir, 'a.ts')).toBe('a 3, an agent wrote this\n');
    expect(await read(dir, 'new.txt')).toBe('new 2, an agent wrote this\n');
  });

  it('skips links, a FIFO, a submodule and a filtered file with their reasons', async () => {
    const dir = await makeRepo({
      '.gitattributes': '*.bin filter=lfs\n',
      'data.bin': 'pointer\n',
      'pipe': 'was a file\n',
      'real.txt': 'r\n',
    });
    await symlink('real.txt', join(dir, 'tracked-link'));
    await git(dir, 'add', 'tracked-link');
    const inner = join(dir, 'vendor', 'sub');
    await mkdir(inner, { recursive: true });
    await git(inner, 'init', '-q');
    await put(inner, 'x', '1\n');
    await git(inner, 'add', 'x');
    await git(inner, 'commit', '-qm', 'one');
    await git(dir, 'add', 'vendor/sub');
    await git(dir, 'commit', '-qm', 'more');

    // Only the smudge leaves a mark: the status runs the clean filter on a modified
    // tracked file, and a checkout is what would run the smudge.
    const marker = join(dir, '.git', 'smudge-ran');
    await git(dir, 'config', 'filter.lfs.clean', 'cat');
    await git(dir, 'config', 'filter.lfs.smudge', `touch '${marker}'; cat`);
    await put(dir, 'data.bin', 'pointer 2\n');
    await put(inner, 'x', '2\n');
    await git(inner, 'commit', '-qam', 'two');
    await unlink(join(dir, 'tracked-link'));
    await symlink('elsewhere', join(dir, 'tracked-link'));
    await symlink('real.txt', join(dir, 'untracked-link'));
    await unlink(join(dir, 'pipe'));
    await exec('mkfifo', [join(dir, 'pipe')]);

    const result = await discard(dir, ['tracked-link', 'untracked-link', 'pipe', 'vendor/sub', 'data.bin']);
    expect(result.done).toEqual([]);
    expect(result.receiptId).toBeNull();
    expect(result.skipped).toEqual([
      { path: 'tracked-link', reason: 'symlink' },
      { path: 'untracked-link', reason: 'symlink' },
      { path: 'pipe', reason: 'special' },
      { path: 'vendor/sub', reason: 'submodule' },
      { path: 'data.bin', reason: 'converted' },
    ]);
    expect((await lstat(join(dir, 'pipe'))).isFIFO()).toBe(true);
    expect(await exists(join(dir, 'untracked-link'))).toBe(true);
    expect(await read(dir, 'data.bin')).toBe('pointer 2\n');
    expect(await exists(marker)).toBe(false);
  });

  describe('a .gitattributes in the same batch', () => {
    // The index holds `*.bin filter=lfs`; the user removed that line and edited the
    // file. Putting `.gitattributes` back restores the filter for every file after it.
    async function lfsRepo(): Promise<{ dir: string; marker: string }> {
      const dir = await makeRepo({ '.gitattributes': '*.bin filter=lfs\n', 'data.bin': 'pointer\n' });
      const marker = join(dir, '.git', 'smudge-ran');
      await git(dir, 'config', 'filter.lfs.clean', 'cat');
      await git(dir, 'config', 'filter.lfs.smudge', `touch '${marker}'; sed s/pointer/SMUDGED/`);
      await put(dir, '.gitattributes', '# no filters now\n');
      await put(dir, 'data.bin', 'pointer 2\n');
      return { dir, marker };
    }

    for (const attributesFirst of [true, false]) {
      /** The request names `.gitattributes` and `name`, in this case's order. */
      const batch = (name: string): string[] => (attributesFirst ? ['.gitattributes', name] : [name, '.gitattributes']);
      const named = attributesFirst ? '.gitattributes first' : '.gitattributes last';

      it(`never runs the filter driver it brings back (${named})`, async () => {
        const { dir, marker } = await lfsRepo();
        const result = await discard(dir, batch('data.bin'));
        expect(result.done).toEqual(['.gitattributes']);
        expect(result.skipped).toEqual([{ path: 'data.bin', reason: 'converted' }]);
        expect(await exists(marker)).toBe(false);
        expect(await read(dir, 'data.bin')).toBe('pointer 2\n');
        expect(await read(dir, '.gitattributes')).toBe('*.bin filter=lfs\n');
      });

      it(`never expands an ident it brings back (${named})`, async () => {
        const dir = await makeRepo({ '.gitattributes': '*.c ident\n', 'x.c': '/* $Id$ */\n' });
        await put(dir, '.gitattributes', '\n');
        await put(dir, 'x.c', '/* $Id$ */ edited\n');
        const result = await discard(dir, batch('x.c'));
        expect(result.done).toEqual(['.gitattributes']);
        expect(result.skipped).toEqual([{ path: 'x.c', reason: 'converted' }]);
        expect(await read(dir, 'x.c')).toBe('/* $Id$ */ edited\n');
        expect(await read(dir, '.gitattributes')).toBe('*.c ident\n');
      });

      it(`writes the line endings the restored .gitattributes asks for (${named})`, async () => {
        // A CRLF checkout, as the index's stat records it: the blob is LF, the file and its size CRLF.
        const dir = await makeRepo({ '.gitattributes': '*.txt eol=crlf\n', 'f.txt': 'a\r\nb\r\n' });
        await put(dir, '.gitattributes', '\n');
        await put(dir, 'f.txt', 'edited\n');
        const result = await discard(dir, batch('f.txt'));
        expect(result.done).toEqual(batch('f.txt'));
        expect(await read(dir, 'f.txt')).toBe('a\r\nb\r\n');
        expect(await git(dir, 'status', '--porcelain')).toBe('');
      });
    }
  });

  it('runs no filter driver when a .gitattributes is written after the attributes were read', async () => {
    const dir = await makeRepo({ 'data.bin': 'pointer\n', 'seed.txt': 's\n' });
    const marker = join(dir, '.git', 'smudge-ran');
    await git(dir, 'config', 'filter.lfs.clean', 'cat');
    await git(dir, 'config', 'filter.lfs.smudge', `touch '${marker}'; cat`);
    await put(dir, 'data.bin', 'pointer 2\n');
    discardHooks.beforeWrite = () => put(dir, '.gitattributes', '*.bin filter=lfs\n');
    const calls: string[][] = [];
    setGitObserver((args) => calls.push([...args]));

    const result = await discard(dir, ['data.bin']);
    setGitObserver(null);
    expect(result.skipped).toEqual([{ path: 'data.bin', reason: 'converted' }]);
    expect(await exists(marker)).toBe(false);
    expect(await read(dir, 'data.bin')).toBe('pointer 2\n');
    // Structural: no command a discard runs can start a driver, whatever the attributes say.
    expect(calls.filter((args) => args.includes('--filters') || args.includes('checkout-index'))).toEqual([]);
  });

  it('writes the bytes git checkout-index writes, for every line-ending rule', async () => {
    const texts = ['', 'text', '-text', 'text=auto', 'text=input', 'crlf', '-crlf', 'crlf=input'];
    const eols = ['', 'eol=lf', 'eol=crlf'];
    const blobs: Record<string, string> = {
      lf: 'a\nb\n',
      crlf: 'a\r\nb\r\n',
      mixed: 'a\r\nb\nc\n',
      cr: 'a\rb\n',
      nul: 'a\n\0b\n',
    };
    const configs = [
      '',
      '[core]\n\tautocrlf = true\n',
      '[core]\n\tautocrlf\n',
      '[core]\n\tautocrlf = input\n',
      '[core]\n\teol = crlf\n',
      '[core]\n\tautocrlf = input\n\teol = crlf\n',
    ];
    const files: Record<string, string> = {};
    const lines: string[] = [];
    texts.forEach((text, t) =>
      eols.forEach((eol, e) => {
        for (const [kind, bytes] of Object.entries(blobs)) {
          const name = `t${t}-e${e}-${kind}.txt`;
          files[name] = bytes;
          if (text !== '' || eol !== '') lines.push(`${name} ${text} ${eol}`.trimEnd());
        }
      }),
    );
    const names = Object.keys(files);

    await Promise.all(
      configs.map(async (config) => {
        // Committed with no conversion, so each blob holds exactly the bytes above.
        const dir = await makeRepo({ '.gitattributes': '* -text\n', ...files });
        await put(dir, '.gitattributes', `${lines.join('\n')}\n`);
        await git(dir, 'add', '.gitattributes');
        await git(dir, 'commit', '-qm', 'attributes');
        await appendFile(join(dir, '.git', 'config'), config);
        await Promise.all(names.map((name) => put(dir, name, 'edited\n')));

        // palmux's bytes, then git's own checkout of the same entries for comparison.
        const result = await discard(dir, names);
        expect(result.done.length, JSON.stringify(config)).toBe(names.length);
        const ours = await Promise.all(names.map((name) => readFile(join(dir, name), 'latin1')));
        await Promise.all(names.map((name) => unlink(join(dir, name))));
        await git(dir, 'checkout-index', '-f', '--', ...names);
        const theirs = await Promise.all(names.map((name) => readFile(join(dir, name), 'latin1')));
        names.forEach((name, i) => expect(ours[i], `${JSON.stringify(config)} ${name}`).toBe(theirs[i]));
      }),
    );
  }, 120_000);

  it('skips a deleted file where a folder or a file now stands in the way, which checkout-index -f would delete', async () => {
    const dir = await makeRepo({ 'a/b.txt': 'b\n', 'c': 'c\n' });
    await rm(join(dir, 'a'), { recursive: true });
    await put(dir, 'a', 'untracked file where the folder was\n');
    await unlink(join(dir, 'c'));
    await put(dir, 'c/keep.txt', 'precious\n');

    const result = await discard(dir, ['a/b.txt', 'c']);
    expect(result.skipped).toEqual([
      { path: 'a/b.txt', reason: 'special' },
      { path: 'c', reason: 'special' },
    ]);
    expect(await read(dir, 'a')).toBe('untracked file where the folder was\n');
    expect(await read(dir, 'c/keep.txt')).toBe('precious\n');
  });

  it('skips a nested repository, an intent-to-add and an entry no longer listed', async () => {
    const dir = await makeRepo({ 'seed.txt': 's\n' });
    await mkdir(join(dir, 'nested'));
    await git(join(dir, 'nested'), 'init', '-q');
    await put(dir, 'later.ts', 'l\n');
    await git(dir, 'add', '-N', 'later.ts');

    const result = await discard(dir, ['nested/', 'later.ts', 'seed.txt']);
    expect(result.skipped).toEqual([
      { path: 'nested/', reason: 'nested-repo' },
      { path: 'later.ts', reason: 'intent-to-add' },
      { path: 'seed.txt', reason: 'gone' },
    ]);
    expect(await read(dir, 'later.ts')).toBe('l\n');
  });

  it('refuses the whole request for a file over 64 MiB, before anything is written', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'a 2\n');
    const big = await open(join(dir, 'big.bin'), 'w');
    await big.truncate(65 * 1024 * 1024);
    await big.close();
    const entries = await listed(dir, ['a.ts', 'big.bin']);
    const objectsBefore = await git(dir, 'count-objects', '-v');

    const result = await discardPaths({ top: dir, entries });
    expect(result).toMatchObject({ ok: false, status: 413 });
    if (!result.ok) expect(result.error).toBe('big.bin is larger than 64 MiB; discard it from a terminal');
    expect(await read(dir, 'a.ts')).toBe('a 2\n');
    expect((await stat(join(dir, 'big.bin'))).size).toBe(65 * 1024 * 1024);
    expect(await git(dir, 'count-objects', '-v')).toBe(objectsBefore);
  });

  it('refuses a bad path, a missing fp and a batch over the limit with a 400', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    for (const entries of [
      [{ path: '../other/secret', fp: 'x' }],
      [{ path: 'a.ts' }],
      [],
      'a.ts',
      Array.from({ length: 5001 }, (_, i) => ({ path: `f${i}`, fp: 'x' })),
    ]) {
      expect(await discardPaths({ top: dir, entries }), JSON.stringify(entries).slice(0, 40)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });

  it('writes nothing outside the project when a folder is swapped for a link during the write', async () => {
    const dir = await makeRepo({ 'sub/t.txt': 't\n' });
    await put(dir, 'sub/t.txt', 't 2\n');
    await put(dir, 'tmp/out/x.txt', 'x\n');
    const outside = await tempDir();
    await put(outside, 'out/x.txt', 'OUTSIDE\n');
    await put(outside, 't.txt', 'OUTSIDE\n');

    discardHooks.beforeWrite = async () => {
      await rename(join(dir, 'sub'), join(dir, 'sub.moved'));
      await symlink(outside, join(dir, 'sub'));
      walkHooks.onStep = async (step) => {
        if (step.kind === 'dir' && step.name === 'tmp' && !(await lstat(join(dir, 'tmp'))).isSymbolicLink()) {
          await rename(join(dir, 'tmp'), join(dir, 'tmp.moved'));
          await symlink(outside, join(dir, 'tmp'));
        }
      };
    };

    const result = await discard(dir, ['sub/t.txt', 'tmp/out/x.txt']);
    expect(result.done).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'sub/t.txt', reason: 'symlink' },
      { path: 'tmp/out/x.txt', reason: 'symlink' },
    ]);
    expect(await read(outside, 't.txt')).toBe('OUTSIDE\n');
    expect(await read(outside, 'out/x.txt')).toBe('OUTSIDE\n');
    expect(await read(dir, 'tmp.moved/out/x.txt')).toBe('x\n');
  });

  it('writes into the folder it opened, never through a link swapped in after its last look', async () => {
    const dir = await makeRepo({ 'sub/t.txt': 't\n', 'sub/gone.txt': 'g\n' });
    await put(dir, 'sub/t.txt', 't 2\n');
    await unlink(join(dir, 'sub/gone.txt'));
    const outside = await tempDir();
    await put(outside, 't.txt', 'OUTSIDE\n');

    // The write has `sub` open and looks at the file one last time: the folder is swapped then.
    let swapped = false;
    discardHooks.beforeWrite = () => {
      walkHooks.onStep = async (step) => {
        if (swapped || step.kind !== 'file' || step.name !== 't.txt') return;
        swapped = true;
        await rename(join(dir, 'sub'), join(dir, 'sub.moved'));
        await symlink(outside, join(dir, 'sub'));
      };
    };

    const result = await discard(dir, ['sub/t.txt', 'sub/gone.txt']);
    expect(swapped).toBe(true);
    expect(result.done).toEqual(['sub/t.txt']);
    expect(result.skipped).toEqual([{ path: 'sub/gone.txt', reason: 'symlink' }]);
    expect(await read(dir, 'sub.moved/t.txt')).toBe('t\n');
    expect(await read(outside, 't.txt')).toBe('OUTSIDE\n');
    expect(await exists(join(outside, 'gone.txt'))).toBe(false);
    expect((await lstat(join(dir, 'sub'))).isSymbolicLink()).toBe(true);
    expect((await readdir(outside)).toSorted()).toEqual(['t.txt']);
  });

  it('records every file it replaced in the receipt, wherever a failure lands after the backup', async () => {
    // A failure at the n-th look at the file after the backups exist must either
    // leave the file alone or leave it restorable: never replaced and unrecorded.
    for (const n of [1, 2, 3]) {
      const dir = await makeRepo({ 'a.ts': 'a\n' });
      await put(dir, 'a.ts', 'a 2\n');
      let looks = 0;
      discardHooks.beforeWrite = () => {
        walkHooks.onStep = (step) => {
          if (step.kind === 'file' && step.name === 'a.ts' && ++looks === n) throw new Error('EIO');
        };
      };

      const result = await discard(dir, ['a.ts']);
      walkHooks.onStep = null;
      if ((await read(dir, 'a.ts')) === 'a 2\n') {
        expect(result.skipped, `failure at look ${n}`).toEqual([{ path: 'a.ts', reason: 'failed' }]);
        expect(result.receiptId).toBeNull();
      } else {
        expect(await read(dir, 'a.ts')).toBe('a\n');
        expect(result.done, `failure at look ${n}`).toEqual(['a.ts']);
        expect((await undo(dir, result.receiptId)).ok).toBe(true);
        expect(await read(dir, 'a.ts')).toBe('a 2\n');
      }
    }
  });

  it('skips a file it cannot write as failed, names the error, and discards the rest', async () => {
    const dir = await makeRepo({ 'ro/a.ts': 'a\n', 'b.ts': 'b\n' });
    await put(dir, 'ro/a.ts', 'a 2\n');
    await put(dir, 'ro/new.txt', 'new\n');
    await put(dir, 'b.ts', 'b 2\n');
    await chmod(join(dir, 'ro'), 0o555);
    try {
      const entries = await listed(dir, ['ro/a.ts', 'ro/new.txt', 'b.ts']);
      const result = await discardPaths({ top: dir, entries });
      if (!result.ok) throw new Error(result.error);
      expect(result.result.done).toEqual(['b.ts']);
      expect(result.result.skipped).toEqual([
        { path: 'ro/a.ts', reason: 'failed' },
        { path: 'ro/new.txt', reason: 'failed' },
      ]);
      expect(result.failures.map((f) => f.path)).toEqual(['ro/a.ts', 'ro/new.txt']);
      expect(result.failures[1]?.error).toMatch(/EACCES/);
      expect(await read(dir, 'ro/a.ts')).toBe('a 2\n');
      expect(await read(dir, 'ro/new.txt')).toBe('new\n');
      expect(await read(dir, 'b.ts')).toBe('b\n');
      expect((await undo(dir, result.result.receiptId)).ok).toBe(true);
      expect(await read(dir, 'b.ts')).toBe('b 2\n');
    } finally {
      await chmod(join(dir, 'ro'), 0o755);
    }
  });

  it('leaves no folder behind for a file it created folders for and then skipped', async () => {
    const dir = await makeRepo({ 'src/keep.ts': 'k\n', 'src/gone/deep/b.ts': 'b\n' });
    await rm(join(dir, 'src/gone'), { recursive: true });
    discardHooks.beforeWrite = () => {
      walkHooks.onStep = (step) => {
        if (step.kind === 'file' && step.name === 'b.ts') throw new Error('EIO');
      };
    };

    const result = await discard(dir, ['src/gone/deep/b.ts']);
    expect(result.skipped).toEqual([{ path: 'src/gone/deep/b.ts', reason: 'failed' }]);
    expect(await exists(join(dir, 'src/gone'))).toBe(false);
    expect(await read(dir, 'src/keep.ts')).toBe('k\n');
  });

  it('discards and restores a file whose name is close to the 255-byte limit', async () => {
    const name = `${'n'.repeat(250)}.txt`;
    const dir = await makeRepo({ [name]: 'one\n' });
    await put(dir, name, 'two\n');

    const result = await discard(dir, [name]);
    expect(result.skipped).toEqual([]);
    expect(result.done).toEqual([name]);
    expect(await read(dir, name)).toBe('one\n');
    expect((await undo(dir, result.receiptId)).ok).toBe(true);
    expect(await read(dir, name)).toBe('two\n');
    expect(await readdir(dir)).toEqual(['.git', name]);
  });

  it('has every backup in the object store before the first write', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'a, never committed anywhere\n');
    await put(dir, 'new.txt', 'new, never committed anywhere\n');
    const oids = await Promise.all(
      ['a.ts', 'new.txt'].map(async (p) => (await git(dir, 'hash-object', '--no-filters', p)).trim()),
    );
    for (const oid of oids) expect(await gitOk(dir, 'cat-file', '-e', oid)).toBe(false);
    const seen: boolean[] = [];
    discardHooks.beforeWrite = async () => {
      for (const oid of oids) seen.push(await gitOk(dir, 'cat-file', '-e', oid));
    };

    expect((await discard(dir, ['a.ts', 'new.txt'])).done).toEqual(['a.ts', 'new.txt']);
    expect(seen).toEqual([true, true]);
  });
});

describe('restoreDiscard', () => {
  it('puts the exact bytes and the mode back', async () => {
    const dir = await makeRepo({ 'run.sh': '#!/bin/sh\necho one\n' });
    await chmod(join(dir, 'run.sh'), 0o755);
    await git(dir, 'add', 'run.sh');
    await git(dir, 'commit', '-qm', 'exec');
    const edited = Buffer.from('#!/bin/sh\r\necho two\r\n\0\xff', 'latin1');
    await put(dir, 'run.sh', edited);
    await put(dir, 'notes.txt', 'private\n');
    await chmod(join(dir, 'notes.txt'), 0o640);

    const result = await discard(dir, ['run.sh', 'notes.txt']);
    expect(await read(dir, 'run.sh')).toBe('#!/bin/sh\necho one\n');
    expect((await stat(join(dir, 'run.sh'))).mode & 0o100).toBe(0o100);
    expect(await exists(join(dir, 'notes.txt'))).toBe(false);

    expect(await undo(dir, result.receiptId)).toEqual({ ok: true, result: { receiptId: null, status: 'restored' } });
    expect((await readFile(join(dir, 'run.sh'))).equals(edited)).toBe(true);
    expect((await stat(join(dir, 'run.sh'))).mode & 0o777).toBe(0o755);
    expect(await read(dir, 'notes.txt')).toBe('private\n');
    expect((await stat(join(dir, 'notes.txt'))).mode & 0o777).toBe(0o640);
  });

  it('brings back deleted untracked files and their folders, and removes a file the discard restored', async () => {
    const dir = await makeRepo({ 'gone.ts': 'g\n' });
    for (const name of ['a', 'b', 'c']) await put(dir, `tmp/out/${name}.txt`, `${name}\n`);
    await unlink(join(dir, 'gone.ts'));
    const result = await discard(dir, ['tmp/out/a.txt', 'tmp/out/b.txt', 'tmp/out/c.txt', 'gone.ts']);
    expect(await exists(join(dir, 'tmp'))).toBe(false);
    expect(await exists(join(dir, 'gone.ts'))).toBe(true);

    expect((await undo(dir, result.receiptId)).ok).toBe(true);
    for (const name of ['a', 'b', 'c']) expect(await read(dir, `tmp/out/${name}.txt`)).toBe(`${name}\n`);
    expect(await exists(join(dir, 'gone.ts'))).toBe(false);
  });

  it('removes the folders the discard created for a deleted file, and keeps one that holds something new', async () => {
    const dir = await makeRepo({ 'src/keep.ts': 'k\n', 'src/gone/deep/b.ts': 'b\n', 'other/c.ts': 'c\n' });
    await rm(join(dir, 'src/gone'), { recursive: true });
    await rm(join(dir, 'other'), { recursive: true });
    const result = await discard(dir, ['src/gone/deep/b.ts', 'other/c.ts']);
    expect(await read(dir, 'src/gone/deep/b.ts')).toBe('b\n');
    await put(dir, 'other/new.txt', 'written after the discard\n');

    expect((await undo(dir, result.receiptId)).ok).toBe(true);
    expect(await exists(join(dir, 'src/gone'))).toBe(false);
    expect(await read(dir, 'src/keep.ts')).toBe('k\n');
    expect(await exists(join(dir, 'other/c.ts'))).toBe(false);
    expect(await readdir(join(dir, 'other'))).toEqual(['new.txt']);
  });

  it('refuses with 409 while a discarded file has been recreated, and works once it is gone again', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'a 2\n');
    await put(dir, 'tmp/new.txt', 'new\n');
    const result = await discard(dir, ['a.ts', 'tmp/new.txt']);
    await put(dir, 'tmp/new.txt', 'an agent made this\n');

    expect(await undo(dir, result.receiptId)).toMatchObject({
      ok: false,
      status: 409,
      code: 'conflict',
      error: 'The files changed since the discard; nothing was undone.',
    });
    expect(await read(dir, 'a.ts')).toBe('a\n');
    expect(await read(dir, 'tmp/new.txt')).toBe('an agent made this\n');

    await unlink(join(dir, 'tmp/new.txt'));
    expect((await undo(dir, result.receiptId)).ok).toBe(true);
    expect(await read(dir, 'a.ts')).toBe('a 2\n');
    expect(await read(dir, 'tmp/new.txt')).toBe('new\n');
  });

  it('refuses with 409 when a file is edited after the comparison, and keeps that edit', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'a 2\n');
    await put(dir, 'tmp/new.txt', 'new\n');
    const result = await discard(dir, ['a.ts', 'tmp/new.txt']);
    discardHooks.afterCompare = () => put(dir, 'a.ts', 'an agent wrote this\n');

    expect(await undo(dir, result.receiptId)).toMatchObject({
      ok: false,
      status: 409,
      code: 'conflict',
      error: 'The files changed since the discard; nothing was undone.',
    });
    expect(await read(dir, 'a.ts')).toBe('an agent wrote this\n');
    expect(await exists(join(dir, 'tmp'))).toBe(false);

    discardHooks.afterCompare = null;
    await put(dir, 'a.ts', 'a\n');
    expect((await undo(dir, result.receiptId)).ok).toBe(true);
    expect(await read(dir, 'a.ts')).toBe('a 2\n');
    expect(await read(dir, 'tmp/new.txt')).toBe('new\n');
  });

  it('stops at a file recreated after the comparison, keeps it, and keeps only the rest in the receipt', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'a 2\n');
    await put(dir, 'tmp/new.txt', 'new\n');
    const result = await discard(dir, ['a.ts', 'tmp/new.txt']);
    discardHooks.afterCompare = () => put(dir, 'tmp/new.txt', 'an agent made this\n');

    expect(await undo(dir, result.receiptId)).toMatchObject({
      ok: false,
      status: 409,
      code: 'conflict',
      error: 'The files changed since the discard; 1 of 2 were restored, and Undo keeps the rest.',
    });
    expect(await read(dir, 'a.ts')).toBe('a 2\n');
    expect(await read(dir, 'tmp/new.txt')).toBe('an agent made this\n');

    discardHooks.afterCompare = null;
    await unlink(join(dir, 'tmp/new.txt'));
    expect((await undo(dir, result.receiptId)).ok).toBe(true);
    expect(await read(dir, 'a.ts')).toBe('a 2\n');
    expect(await read(dir, 'tmp/new.txt')).toBe('new\n');
  });

  it('writes nothing outside the project when a folder is swapped for a link before the Undo writes', async () => {
    const dir = await makeRepo({ 'sub/t.txt': 't\n' });
    await put(dir, 'sub/t.txt', 't 2\n');
    await put(dir, 'tmp/out/x.txt', 'x\n');
    const outside = await tempDir();
    await put(outside, 't.txt', 'OUTSIDE\n');
    const result = await discard(dir, ['sub/t.txt', 'tmp/out/x.txt']);
    expect(await exists(join(dir, 'tmp'))).toBe(false);

    // The comparison has passed; both folders are links to elsewhere by the time it writes.
    discardHooks.afterCompare = async () => {
      await rename(join(dir, 'sub'), join(dir, 'sub.moved'));
      await symlink(outside, join(dir, 'sub'));
      await symlink(outside, join(dir, 'tmp'));
    };

    const res = await undo(dir, result.receiptId);
    expect(res).toMatchObject({ ok: false, status: 409, code: 'conflict' });
    expect(await read(outside, 't.txt')).toBe('OUTSIDE\n');
    expect((await readdir(outside)).toSorted()).toEqual(['t.txt']);
    expect(await read(dir, 'sub.moved/t.txt')).toBe('t\n');
  });

  it('is 410 once a receipt is spent or older than ten minutes, and 400 for another project', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    const other = await makeRepo({ 'c.ts': 'c\n' });
    await put(dir, 'a.ts', 'a 2\n');
    await put(dir, 'b.ts', 'b 2\n');
    const first = await discard(dir, ['a.ts']);
    const second = await discard(dir, ['b.ts']);

    expect(await undo(other, first.receiptId)).toMatchObject({ ok: false, status: 400 });
    expect((await undo(dir, first.receiptId)).ok).toBe(true);
    expect(await undo(dir, first.receiptId)).toMatchObject({
      ok: false,
      status: 410,
      code: 'token',
      error: 'Undo is no longer available.',
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DISCARD_RECEIPT_MS + 1);
    expect(await undo(dir, second.receiptId)).toMatchObject({ ok: false, status: 410, code: 'token' });
    expect(await read(dir, 'b.ts')).toBe('b\n');
    expect(await restoreDiscard({ top: dir, receiptId: 'dnope' })).toMatchObject({ status: 410 });
  });

  it('keeps 20 receipts, dropping only the oldest, and index receipts never push one out', async () => {
    const dir = await makeRepo(
      Object.fromEntries(Array.from({ length: DISCARD_RECEIPT_MAX + 1 }, (_, i) => [`f${i}.ts`, `${i}\n`])),
    );
    const ids: (string | null)[] = [];
    for (let i = 0; i <= DISCARD_RECEIPT_MAX; i++) {
      await put(dir, `f${i}.ts`, `${i} edited\n`);
      ids.push((await discard(dir, [`f${i}.ts`])).receiptId);
    }

    // 64 MB of index receipts: the shared cache evicts its own, never a discard receipt.
    const filler = Array.from({ length: 70_000 }, () => ({ path: 'x', before: [], after: [] }));
    const firstIndexReceipt = putReceipt({ top: dir, entries: filler });
    for (let i = 0; i < 3; i++) putReceipt({ top: dir, entries: filler });
    expect(getReceipt(firstIndexReceipt)).toBeUndefined();
    expect(scmCacheStats().bytes).toBeLessThanOrEqual(64 * 1024 * 1024);

    expect(await undo(dir, ids[0] ?? null)).toMatchObject({ ok: false, status: 410 });
    expect((await undo(dir, ids[1] ?? null)).ok).toBe(true);
    expect((await undo(dir, ids[DISCARD_RECEIPT_MAX] ?? null)).ok).toBe(true);
    expect(await read(dir, 'f1.ts')).toBe('1 edited\n');
    expect(await read(dir, `f${DISCARD_RECEIPT_MAX}.ts`)).toBe(`${DISCARD_RECEIPT_MAX} edited\n`);
  });
});
