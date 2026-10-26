// Snapshots: the unified-diff parser, git's line-ending rule, both sides of every
// pair kind, the safe work tree walk, and the token cache.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ScmAlgorithm, ScmFileSnapshot, ScmGroup } from '@palmux/shared';
import { setGitObserver } from './scm-git';
import {
  SIDE_LIMIT_BYTES,
  configureScmCache,
  crlfToLf,
  eolDecision,
  gatherStats,
  getReceipt,
  getToken,
  parseUnifiedDiff,
  putReceipt,
  putToken,
  readAttrContext,
  readSnapshot,
  resetScmCache,
  scmCacheStats,
  walkHooks,
} from './scm-snapshot';

const exec = promisify(execFile);

let home: string;
let savedHome: string | undefined;
let savedXdg: string | undefined;
const baseConfig =
  '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n';
const created: string[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'palmux-scm-home-'));
  await writeFile(join(home, '.gitconfig'), baseConfig);
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

afterEach(async () => {
  walkHooks.onStep = null;
  walkHooks.procFdDir = '/proc/self/fd';
  setGitObserver(null);
  delete process.env['GIT_DIFF_OPTS'];
  resetScmCache();
  configureScmCache({ maxBytes: 64 * 1024 * 1024, ttlMs: 10 * 60 * 1000 });
  vi.useRealTimers();
  await writeFile(join(home, '.gitconfig'), baseConfig);
});

function fixtureEnv(): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: fixtureEnv() });
  return stdout;
}

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'palmux-scm-snap-')));
  created.push(dir);
  return dir;
}

async function put(dir: string, rel: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content);
}

async function makeRepo(
  files: Record<string, string | Buffer> = {},
  opts: { commit?: boolean; args?: string[] } = {},
): Promise<string> {
  const dir = await tempDir();
  await git(dir, 'init', '-q', ...(opts.args ?? []));
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
  if (opts.commit ?? true) {
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

async function commitAll(dir: string, message = 'next'): Promise<void> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', message);
}

/** The blob id git itself gives these bytes in this repository's object format. */
async function blobId(dir: string, content: string | Buffer): Promise<string> {
  const file = join(await tempDir(), 'blob');
  await writeFile(file, content);
  return (await git(dir, 'hash-object', '--no-filters', file)).trim();
}

async function snap(
  dir: string,
  group: ScmGroup,
  path: string,
  opts: { oldPath?: string; algorithm?: ScmAlgorithm } = {},
): Promise<ScmFileSnapshot> {
  const result = await readSnapshot({
    top: dir,
    group,
    path,
    oldPath: opts.oldPath,
    algorithm: opts.algorithm ?? 'histogram',
  });
  if (!result.ok) throw new Error(`snapshot failed (${result.status}): ${result.error}`);
  return result.snapshot;
}

async function snapFailure(dir: string, group: ScmGroup, path: string) {
  const result = await readSnapshot({ top: dir, group, path, algorithm: 'histogram' });
  if (result.ok) throw new Error('expected a failure');
  return result;
}

/** Every hunk line must be the line at that number in the side it names. */
function expectHunksMatchText(s: ScmFileSnapshot): void {
  const oldLines = s.old.text.split('\n');
  const newLines = s.new.text.split('\n');
  for (const hunk of s.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== 'add') expect(oldLines[(line.old as number) - 1]).toBe(line.text);
      if (line.kind !== 'del') expect(newLines[(line.new as number) - 1]).toBe(line.text);
    }
  }
}

const changed = (s: ScmFileSnapshot) => s.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx'));

/** git's own hunks for two texts, from a plain `git diff --no-index` in the fixture's environment. */
async function gitsOwnHunks(algorithm: ScmAlgorithm, oldText: string, newText: string) {
  const dir = await tempDir();
  await writeFile(join(dir, 'old'), oldText);
  await writeFile(join(dir, 'new'), newText);
  let out = '';
  try {
    out = await git(dir, 'diff', '--no-index', '--no-color', `--diff-algorithm=${algorithm}`, '-U3', 'old', 'new');
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? '');
  }
  return parseUnifiedDiff(out);
}

async function withGlobalConfig(extra: string, body: () => Promise<void>): Promise<void> {
  await appendFile(join(home, '.gitconfig'), extra);
  try {
    await body();
  } finally {
    await writeFile(join(home, '.gitconfig'), baseConfig);
  }
}

// ── Pure pieces ───────────────────────────────────────────────────────────────

describe('parseUnifiedDiff', () => {
  it('reads hunks with each line numbered on its own side', () => {
    const hunks = parseUnifiedDiff(
      [
        'diff --git a/old b/new',
        'index 111..222 100644',
        '--- a/old',
        '+++ b/new',
        '@@ -2,4 +2,5 @@ function head()',
        ' ctx one',
        '-gone',
        '+new a',
        '+new b',
        ' ctx two',
        ' ctx three',
        '@@ -20 +21,0 @@',
        '-dropped',
        '',
      ].join('\n'),
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 2, oldLines: 4, newStart: 2, newLines: 5, header: 'function head()' });
    expect(hunks[0]?.lines).toEqual([
      { kind: 'ctx', old: 2, new: 2, text: 'ctx one' },
      { kind: 'del', old: 3, text: 'gone' },
      { kind: 'add', new: 3, text: 'new a' },
      { kind: 'add', new: 4, text: 'new b' },
      { kind: 'ctx', old: 4, new: 5, text: 'ctx two' },
      { kind: 'ctx', old: 5, new: 6, text: 'ctx three' },
    ]);
    expect(hunks[1]).toMatchObject({ oldStart: 20, oldLines: 1, newStart: 21, newLines: 0, header: '' });
    expect(hunks[1]?.lines).toEqual([{ kind: 'del', old: 20, text: 'dropped' }]);
  });

  it('marks the line before a "No newline" marker', () => {
    const hunks = parseUnifiedDiff(
      ['@@ -1,2 +1,2 @@', ' same', '-old tail', '\\ No newline at end of file', '+new tail', ''].join('\n'),
    );
    expect(hunks[0]?.lines).toEqual([
      { kind: 'ctx', old: 1, new: 1, text: 'same' },
      { kind: 'del', old: 2, text: 'old tail', noEol: true },
      { kind: 'add', new: 2, text: 'new tail' },
    ]);
  });

  it('keeps a carriage return as part of the line text', () => {
    const hunks = parseUnifiedDiff('@@ -1 +1 @@\n-a\r\n+b\r\n');
    expect(hunks[0]?.lines.map((l) => l.text)).toEqual(['a\r', 'b\r']);
  });

  it('is empty when there is no hunk', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('diff --git a/old b/new\nBinary files a/old and b/new differ\n')).toEqual([]);
  });
});

describe('gatherStats and crlfToLf', () => {
  it('counts the way git does', () => {
    expect(gatherStats(Buffer.from('a\r\nb\nc\rd'))).toMatchObject({ crlf: 1, lonelf: 1, lonecr: 1, nul: 0 });
    expect(gatherStats(Buffer.from([0x61, 0, 0x62]))).toMatchObject({ nul: 1, nonprintable: 1, printable: 2 });
    expect(gatherStats(Buffer.from('\t\b\x1b\x0c'))).toMatchObject({ printable: 4, nonprintable: 0 });
    // A trailing Ctrl-Z does not count against the file.
    expect(gatherStats(Buffer.from('ab\x1a')).nonprintable).toBe(0);
  });

  it('drops a CR only where an LF follows it', () => {
    expect(crlfToLf(Buffer.from('a\r\nb\rc\r\n')).toString()).toBe('a\nb\rc\n');
    const lf = Buffer.from('plain\n');
    expect(crlfToLf(lf)).toBe(lf);
  });
});

describe('eolDecision', () => {
  const crlf = Buffer.from('a\r\nb\r\n');
  const lf = Buffer.from('a\nb\n');
  const decide = (attrs: Record<string, string>, autocrlf: string, work: Buffer, index: Buffer | null = null) =>
    eolDecision(attrs, autocrlf, work, index);

  it('does not convert when nothing asks for it', () => {
    expect(decide({}, 'false', crlf)).toEqual({ convert: false, why: 'off' });
    expect(decide({ text: 'unset' }, 'true', crlf)).toEqual({ convert: false, why: 'off' });
    expect(decide({ text: 'unset', eol: 'crlf' }, 'false', crlf)).toEqual({ convert: false, why: 'off' });
    expect(decide({ text: 'set' }, 'false', Buffer.alloc(0))).toEqual({ convert: false, why: 'off' });
  });

  it('always converts for explicit text, whatever the bytes or the index hold', () => {
    expect(decide({ text: 'set' }, 'false', crlf, crlf)).toEqual({ convert: true, why: 'on' });
    expect(decide({ text: 'input' }, 'false', crlf)).toEqual({ convert: true, why: 'on' });
    expect(decide({ crlf: 'set' }, 'false', crlf)).toEqual({ convert: true, why: 'on' });
    expect(decide({ eol: 'lf' }, 'false', crlf)).toEqual({ convert: true, why: 'on' });
    expect(decide({ text: 'set' }, 'false', Buffer.from('a\r\n\0b'))).toEqual({ convert: true, why: 'on' });
  });

  it('converts text=auto only for text that its index blob does not already hold as CRLF', () => {
    expect(decide({ text: 'auto' }, 'false', crlf)).toEqual({ convert: true, why: 'on' });
    expect(decide({ text: 'auto' }, 'false', crlf, lf)).toEqual({ convert: true, why: 'on' });
    expect(decide({ text: 'auto' }, 'false', crlf, crlf)).toEqual({ convert: false, why: 'crlf-in-index' });
    expect(decide({ text: 'auto' }, 'false', Buffer.from('a\r\n\0'))).toEqual({ convert: false, why: 'binary' });
    expect(decide({ text: 'auto' }, 'false', Buffer.from('a\rb\r\n'))).toEqual({ convert: false, why: 'binary' });
  });

  it('treats an index blob that is binary as not already CRLF', () => {
    expect(decide({ text: 'auto' }, 'false', crlf, Buffer.from('a\r\n\0'))).toEqual({ convert: true, why: 'on' });
  });

  it('applies the same guard to an unspecified text under core.autocrlf true or input', () => {
    for (const autocrlf of ['true', 'input']) {
      expect(decide({}, autocrlf, crlf)).toEqual({ convert: true, why: 'on' });
      expect(decide({}, autocrlf, crlf, crlf)).toEqual({ convert: false, why: 'crlf-in-index' });
      expect(decide({ text: 'unspecified', crlf: 'unspecified' }, autocrlf, lf)).toEqual({ convert: true, why: 'on' });
    }
  });
});

// ── Both sides of every pair ──────────────────────────────────────────────────

describe('an unstaged change', () => {
  it('compares the index blob with the work tree and offers a token', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\ntwo\nthree\n' });
    await put(dir, 'a.ts', 'one\nTWO\nthree\n');
    const s = await snap(dir, 'changes', 'a.ts');

    expect(s).toMatchObject({ path: 'a.ts', group: 'changes', algorithm: 'histogram' });
    expect(s.old).toEqual({ id: await blobId(dir, 'one\ntwo\nthree\n'), text: 'one\ntwo\nthree\n' });
    expect(s.new).toEqual({ id: await blobId(dir, 'one\nTWO\nthree\n'), text: 'one\nTWO\nthree\n' });
    expect(s.old.id).toBe((await git(dir, 'rev-parse', ':a.ts')).trim());
    expect(s.modes).toEqual({ old: '100644', new: '100644' });
    expect(changed(s).map((l) => [l.kind, l.text])).toEqual([
      ['del', 'two'],
      ['add', 'TWO'],
    ]);
    expect(s).toMatchObject({ binary: false, tooLarge: false, converted: false, unmerged: false });
    expect(s.version).toMatch(/^[0-9a-f]{16}$/);
    expect(s.token).toBeTruthy();
    expectHunksMatchText(s);
  });

  it('shows an untracked file as all added, from an absent old side', async () => {
    const dir = await makeRepo({ 'seed.txt': 's\n' });
    await put(dir, 'fresh/new.ts', 'x\ny\n');
    const s = await snap(dir, 'changes', 'fresh/new.ts');
    expect(s.old).toEqual({ id: 'absent', text: '' });
    expect(s.new.text).toBe('x\ny\n');
    expect(s.modes).toEqual({ new: '100644' });
    expect(changed(s).map((l) => l.kind)).toEqual(['add', 'add']);
    expect(s.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    expect(s.token).toBeTruthy();
  });

  it('shows a file deleted from the work tree as all removed, with a token for the deletion', async () => {
    const dir = await makeRepo({ 'gone.ts': 'a\nb\n' });
    await rm(join(dir, 'gone.ts'));
    const s = await snap(dir, 'changes', 'gone.ts');
    expect(s.new).toEqual({ id: 'absent', text: '' });
    expect(s.old.text).toBe('a\nb\n');
    expect(s.modes).toEqual({ old: '100644' });
    expect(changed(s).map((l) => l.kind)).toEqual(['del', 'del']);
    expect(s.token).toBeTruthy();
  });

  it('shows a directory where the tracked file was as a deleted file', async () => {
    const dir = await makeRepo({ 'thing': 'file\n' });
    await rm(join(dir, 'thing'));
    await put(dir, 'thing/inner.txt', 'x\n');
    const s = await snap(dir, 'changes', 'thing');
    expect(s.new.id).toBe('absent');
    expect(s.old.text).toBe('file\n');
  });

  it('gives no token when neither the index nor the work tree has the file', async () => {
    const dir = await makeRepo({ 'seed.txt': 's\n' });
    const s = await snap(dir, 'changes', 'never-existed.ts');
    expect(s.old.id).toBe('absent');
    expect(s.new.id).toBe('absent');
    expect(s.hunks).toEqual([]);
    expect(s.token).toBeUndefined();
  });

  it('records the work tree id as git blob id in sha256 repositories too', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n' }, { args: ['--object-format=sha256'] });
    await put(dir, 'a.ts', 'two\n');
    const s = await snap(dir, 'changes', 'a.ts');
    expect(s.new.id).toHaveLength(64);
    expect(s.new.id).toBe(await blobId(dir, 'two\n'));
    expect(s.old.id).toHaveLength(64);
  });
});

describe('a staged change', () => {
  it('compares HEAD with the index and offers no token', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\ntwo\n' });
    await put(dir, 'a.ts', 'one\nTWO\n');
    await git(dir, 'add', 'a.ts');
    await put(dir, 'a.ts', 'one\nTWO\nthree\n');

    const staged = await snap(dir, 'staged', 'a.ts');
    expect(staged.old.text).toBe('one\ntwo\n');
    expect(staged.new.text).toBe('one\nTWO\n');
    expect(staged.new.id).toBe((await git(dir, 'rev-parse', ':a.ts')).trim());
    expect(staged.token).toBeUndefined();
    expectHunksMatchText(staged);

    const unstaged = await snap(dir, 'changes', 'a.ts');
    expect(unstaged.old.text).toBe('one\nTWO\n');
    expect(unstaged.new.text).toBe('one\nTWO\nthree\n');
  });

  it('shows every line as added for a file staged before the first commit, without asking ls-tree', async () => {
    const dir = await makeRepo({ 'a.ts': 'x\ny\nz\n' }, { commit: false });
    await git(dir, 'add', 'a.ts');
    const seen: string[] = [];
    setGitObserver((args) => seen.push(args[0] ?? ''));
    const s = await snap(dir, 'staged', 'a.ts');
    expect(seen).not.toContain('ls-tree');
    expect(s.old).toEqual({ id: 'absent', text: '' });
    expect(s.new.text).toBe('x\ny\nz\n');
    expect(changed(s).map((l) => l.kind)).toEqual(['add', 'add', 'add']);
  });

  it('shows a staged deletion as all removed', async () => {
    const dir = await makeRepo({ 'gone.ts': 'a\nb\n' });
    await git(dir, 'rm', '-q', 'gone.ts');
    const s = await snap(dir, 'staged', 'gone.ts');
    expect(s.new).toEqual({ id: 'absent', text: '' });
    expect(changed(s).map((l) => l.kind)).toEqual(['del', 'del']);
  });

  it('shows a staged rename as the pair it is: one changed line, not a new file', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join('');
    const dir = await makeRepo({ 'a.ts': body });
    await git(dir, 'mv', 'a.ts', 'b.ts');
    await put(dir, 'b.ts', body.replace('line 5', 'LINE 5'));
    await git(dir, 'add', 'b.ts');

    const s = await snap(dir, 'staged', 'b.ts', { oldPath: 'a.ts' });
    expect(s.path).toBe('b.ts');
    expect(s.oldPath).toBe('a.ts');
    expect(changed(s).map((l) => [l.kind, l.text])).toEqual([
      ['del', 'line 5'],
      ['add', 'LINE 5'],
    ]);
    expect(s.old.text).toBe(body);
  });

  it('ignores oldPath when it equals path or when the group is changes', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await put(dir, 'a.ts', 'b\n');
    expect((await snap(dir, 'changes', 'a.ts', { oldPath: 'other.ts' })).oldPath).toBeUndefined();
    await git(dir, 'add', 'a.ts');
    expect((await snap(dir, 'staged', 'a.ts', { oldPath: 'a.ts' })).oldPath).toBeUndefined();
  });
});

describe('modes and symbolic links', () => {
  it('lists a mode-only change with both modes and no hunks', async () => {
    const dir = await makeRepo({ 'run.sh': '#!/bin/sh\n' });
    await chmod(join(dir, 'run.sh'), 0o755);
    const s = await snap(dir, 'changes', 'run.sh');
    expect(s.modes).toEqual({ old: '100644', new: '100755' });
    expect(s.hunks).toEqual([]);
    expect(s.old.id).toBe(s.new.id);
    expect(s.binary).toBe(false);

    await git(dir, 'add', 'run.sh');
    const staged = await snap(dir, 'staged', 'run.sh');
    expect(staged.modes).toEqual({ old: '100644', new: '100755' });
    expect(staged.hunks).toEqual([]);
  });

  it('keeps the index mode when core.fileMode is off', async () => {
    const dir = await makeRepo({ 'run.sh': '#!/bin/sh\n' });
    await git(dir, 'config', 'core.fileMode', 'false');
    await chmod(join(dir, 'run.sh'), 0o755);
    const s = await snap(dir, 'changes', 'run.sh');
    expect(s.modes).toEqual({ old: '100644', new: '100644' });
  });

  it('answers the target text of a symlink in the final component', async () => {
    const dir = await makeRepo({ 'target.txt': 'hello\n' });
    await symlink('target.txt', join(dir, 'link'));
    const s = await snap(dir, 'changes', 'link');
    expect(s.new.text).toBe('target.txt');
    expect(s.new.id).toBe(await blobId(dir, 'target.txt'));
    expect(s.modes).toEqual({ new: '120000' });
    expect(s.symlink).toEqual({ new: true });
    expect(s.token).toBeTruthy();
  });

  it('shows a tracked symlink retargeted, and a link replacing a file', async () => {
    const dir = await makeRepo({ 'one.txt': '1\n', 'two.txt': '2\n', 'f': 'regular\n' });
    await symlink('one.txt', join(dir, 'link'));
    await commitAll(dir);
    await rm(join(dir, 'link'));
    await symlink('two.txt', join(dir, 'link'));
    const retargeted = await snap(dir, 'changes', 'link');
    expect(retargeted.old.text).toBe('one.txt');
    expect(retargeted.new.text).toBe('two.txt');
    expect(retargeted.symlink).toEqual({ old: true, new: true });

    await rm(join(dir, 'f'));
    await symlink('one.txt', join(dir, 'f'));
    const typed = await snap(dir, 'changes', 'f');
    expect(typed.modes).toEqual({ old: '100644', new: '120000' });
    expect(typed.symlink).toEqual({ old: false, new: true });
  });
});

describe('names that look like patterns or stage selectors', () => {
  it('reads a.ts-style names literally, beside a file a pattern would also match', async () => {
    const dir = await makeRepo({ 'a*.ts': 'star one\n', 'alpha.ts': 'alpha one\n' });
    await put(dir, 'a*.ts', 'star two\n');
    await put(dir, 'alpha.ts', 'alpha two\n');

    const unstaged = await snap(dir, 'changes', 'a*.ts');
    expect(unstaged.old.text).toBe('star one\n');
    expect(unstaged.new.text).toBe('star two\n');
    expect(JSON.stringify(unstaged)).not.toContain('alpha');

    await git(dir, 'add', 'a*.ts');
    const staged = await snap(dir, 'staged', 'a*.ts');
    expect(staged.old.text).toBe('star one\n');
    expect(staged.new.text).toBe('star two\n');
    expect(JSON.stringify(staged)).not.toContain('alpha');
  });

  it('reads 2:config.ts by object id, never as merge stage 2', async () => {
    const dir = await makeRepo({ '2:config.ts': 'colon one\n', 'config.ts': 'plain one\n' });
    await put(dir, '2:config.ts', 'colon two\n');
    await put(dir, 'config.ts', 'plain two\n');
    const s = await snap(dir, 'changes', '2:config.ts');
    expect(s.old.text).toBe('colon one\n');
    expect(s.new.text).toBe('colon two\n');
    await git(dir, 'add', '2:config.ts');
    const staged = await snap(dir, 'staged', '2:config.ts');
    expect(staged.new.text).toBe('colon two\n');
  });

  it('keeps a name with a leading or trailing space apart from its neighbour', async () => {
    const dir = await makeRepo({ 'report': 'plain\n', 'report ': 'spaced\n' });
    await put(dir, 'report ', 'spaced two\n');
    const s = await snap(dir, 'changes', 'report ');
    expect(s.old.text).toBe('spaced\n');
    expect(s.new.text).toBe('spaced two\n');
  });
});

describe('unmerged paths', () => {
  it('answers a read-only snapshot without asking for any blob', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\ntwo\nthree\n' });
    await git(dir, 'checkout', '-q', '-b', 'other');
    await put(dir, 'a.ts', 'one\nOTHER\nthree\n');
    await git(dir, 'commit', '-qam', 'other');
    await git(dir, 'checkout', '-q', 'main');
    await put(dir, 'a.ts', 'one\nMAIN\nthree\n');
    await git(dir, 'commit', '-qam', 'main');
    await git(dir, 'merge', 'other').catch(() => undefined);

    const seen: string[] = [];
    setGitObserver((args) => seen.push(args[0] ?? ''));
    for (const group of ['changes', 'staged'] as const) {
      const s = await snap(dir, group, 'a.ts');
      expect(s.unmerged).toBe(true);
      expect(s.hunks).toEqual([]);
      expect(s.token).toBeUndefined();
      expect(s.old.id).toBe('absent');
      expect(s.new.id).toBe('absent');
    }
    expect(seen).not.toContain('cat-file');
  });
});

// ── git's own hunks ───────────────────────────────────────────────────────────

describe('algorithms and the pinned diff configuration', () => {
  const oldText = [
    'int a(void)',
    '{',
    '\treturn 1;',
    '}',
    '',
    'int b(void)',
    '{',
    '\treturn 2;',
    '}',
    '',
    'int c(void)',
    '{',
    '\treturn 3;',
    '}',
    '',
  ].join('\n');
  const newText = [
    'int c(void)',
    '{',
    '\treturn 3;',
    '}',
    '',
    'int a(void)',
    '{',
    '\treturn 1;',
    '}',
    '',
    'int d(void)',
    '{',
    '\treturn 4;',
    '}',
    '',
    'int b(void)',
    '{',
    '\treturn 2;',
    '}',
    '',
  ].join('\n');

  it('answers git’s own hunks for each algorithm, and they differ where git’s do', async () => {
    const dir = await makeRepo({ 'f.c': oldText });
    await put(dir, 'f.c', newText);
    const results = new Map<ScmAlgorithm, ScmFileSnapshot>();
    for (const algorithm of ['myers', 'minimal', 'patience', 'histogram'] as const) {
      const s = await snap(dir, 'changes', 'f.c', { algorithm });
      expect(s.algorithm).toBe(algorithm);
      expect(s.hunks, algorithm).toEqual(await gitsOwnHunks(algorithm, oldText, newText));
      expectHunksMatchText(s);
      results.set(algorithm, s);
    }
    const myers = results.get('myers') as ScmFileSnapshot;
    const histogram = results.get('histogram') as ScmFileSnapshot;
    expect(myers.hunks).not.toEqual(histogram.hunks);
  });

  it('keeps version free of the algorithm', async () => {
    const dir = await makeRepo({ 'f.c': oldText });
    await put(dir, 'f.c', newText);
    const versions = new Set<string>();
    for (const algorithm of ['myers', 'minimal', 'patience', 'histogram'] as const) {
      versions.add((await snap(dir, 'changes', 'f.c', { algorithm })).version);
    }
    expect(versions.size).toBe(1);
  });

  it('rejects an unknown algorithm or group', async () => {
    const dir = await makeRepo({ 'f.c': 'a\n' });
    const bad = await readSnapshot({ top: dir, group: 'changes', path: 'f.c', algorithm: 'bogus' as ScmAlgorithm });
    expect(!bad.ok && bad.status).toBe(400);
    const badGroup = await readSnapshot({ top: dir, group: 'nope' as ScmGroup, path: 'f.c', algorithm: 'myers' });
    expect(!badGroup.ok && badGroup.status).toBe(400);
  });

  const blankLineFile = (marker: string) => ['a', '', 'b', marker, 'c', '', 'd', ''].join('\n');

  it('does not let GIT_DIFF_OPTS or the user’s diff config change the hunks', async () => {
    const dir = await makeRepo({ 'f.txt': blankLineFile('old') });
    await put(dir, 'f.txt', blankLineFile('new'));
    const baseline = await snap(dir, 'changes', 'f.txt');
    expect(baseline.hunks[0]?.lines.length).toBe(8);
    expect(baseline.hunks[0]?.lines.some((l) => l.kind === 'ctx' && l.text === '')).toBe(true);

    process.env['GIT_DIFF_OPTS'] = '-u1';
    expect((await snap(dir, 'changes', 'f.txt')).hunks).toEqual(baseline.hunks);
    delete process.env['GIT_DIFF_OPTS'];

    await withGlobalConfig(
      '[diff]\n\tsuppressBlankEmpty = true\n\tnoprefix = true\n\tmnemonicPrefix = true\n\tcontext = 1\n\tinterHunkContext = 5\n\tindentHeuristic = false\n\talgorithm = minimal\n',
      async () => {
        expect((await snap(dir, 'changes', 'f.txt')).hunks).toEqual(baseline.hunks);
      },
    );

    await git(dir, 'config', 'diff.suppressBlankEmpty', 'true');
    await git(dir, 'config', 'diff.noprefix', 'true');
    expect((await snap(dir, 'changes', 'f.txt')).hunks).toEqual(baseline.hunks);
  });

  it('does not let a global core.autocrlf reshape a CRLF blob that was kept', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\r\ntwo\r\n' });
    await put(dir, 'a.txt', 'one\r\nTWO\r\n');
    await withGlobalConfig('[core]\n\tautocrlf = true\n', async () => {
      const s = await snap(dir, 'changes', 'a.txt');
      // git itself would not convert: the index blob already holds CRLF.
      expect(s.attrs['convert']).toBe('crlf-in-index');
      expect(changed(s).map((l) => l.text)).toEqual(['two\r', 'TWO\r']);
      expectHunksMatchText(s);
    });
  });
});

// ── Line endings and attributes ───────────────────────────────────────────────

describe('line endings', () => {
  it('shows only the real edit when text eol=crlf checks out CRLF over an LF blob', async () => {
    const dir = await makeRepo({ 'docs/a.txt': 'one\ntwo\nthree\n' });
    await put(dir, 'docs/.gitattributes', 'a.txt text eol=crlf\n');
    await commitAll(dir);
    await put(dir, 'docs/a.txt', 'one\r\nTWO\r\nthree\r\n');

    const s = await snap(dir, 'changes', 'docs/a.txt');
    expect(changed(s).map((l) => [l.kind, l.text])).toEqual([
      ['del', 'two'],
      ['add', 'TWO'],
    ]);
    expect(s.new.text).toBe('one\nTWO\nthree\n');
    expect(s.new.id).toBe(await blobId(dir, 'one\nTWO\nthree\n'));
    expect(s.attrs).toMatchObject({ text: 'set', eol: 'crlf', convert: 'on' });
    expectHunksMatchText(s);
  });

  it('diffs line for line a CRLF blob that was never renormalised under * text=auto', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
    await put(dir, '.gitattributes', '* text=auto\n');
    await commitAll(dir);
    await put(dir, 'a.txt', 'one\r\nTWO\r\nthree\r\n');

    const s = await snap(dir, 'changes', 'a.txt');
    expect(changed(s).map((l) => [l.kind, l.text])).toEqual([
      ['del', 'two\r'],
      ['add', 'TWO\r'],
    ]);
    expect(s.new.text).toBe('one\r\nTWO\r\nthree\r\n');
    expect(s.new.id).toBe(await blobId(dir, 'one\r\nTWO\r\nthree\r\n'));
    expect(s.attrs['convert']).toBe('crlf-in-index');
    expectHunksMatchText(s);
  });

  it('converts a CRLF checkout of an LF blob under text=auto and under core.autocrlf', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\ntwo\n', 'b.txt': 'one\ntwo\n' });
    await put(dir, '.gitattributes', 'a.txt text=auto\n');
    await commitAll(dir);
    await git(dir, 'config', 'core.autocrlf', 'true');
    await put(dir, 'a.txt', 'one\r\nTWO\r\n');
    await put(dir, 'b.txt', 'one\r\nTWO\r\n');

    for (const name of ['a.txt', 'b.txt']) {
      const s = await snap(dir, 'changes', name);
      expect(changed(s).map((l) => [l.kind, l.text]), name).toEqual([
        ['del', 'two'],
        ['add', 'TWO'],
      ]);
      expect(s.attrs['convert']).toBe('on');
    }
  });

  it('converts an untracked CRLF file, which has no index blob to guard', async () => {
    const dir = await makeRepo({ '.gitattributes': '* text=auto\n' });
    await put(dir, 'new.txt', 'a\r\nb\r\n');
    const s = await snap(dir, 'changes', 'new.txt');
    expect(s.new.text).toBe('a\nb\n');
    expect(s.attrs['convert']).toBe('on');
  });

  it('leaves CRLF alone for -text, and for a text=auto file git treats as binary', async () => {
    const dir = await makeRepo({ '.gitattributes': '* text=auto\n*.dat -text\n', 'a.dat': 'a\r\n', 'b.txt': 'a\n' });
    await put(dir, 'a.dat', 'a\r\nb\r\n');
    const dat = await snap(dir, 'changes', 'a.dat');
    expect(dat.new.text).toBe('a\r\nb\r\n');
    expect(dat.attrs['convert']).toBe('off');

    await put(dir, 'b.txt', 'a\rb\r\nc\r\n');
    const lone = await snap(dir, 'changes', 'b.txt');
    expect(lone.attrs['convert']).toBe('binary');
    expect(lone.new.text).toBe('a\rb\r\nc\r\n');
  });

  it('records the attribute context and moves version with it', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    await put(dir, 'a.txt', 'b\n');
    const before = await snap(dir, 'changes', 'a.txt');
    expect(before.attrs).toMatchObject({
      text: 'unspecified',
      eol: 'unspecified',
      diff: 'unspecified',
      filter: 'unspecified',
      'core.autocrlf': 'false',
      'core.eol': 'unset',
      convert: 'off',
    });
    expect((await snap(dir, 'changes', 'a.txt')).version).toBe(before.version);

    await put(dir, '.gitattributes', 'a.txt text\n');
    const after = await snap(dir, 'changes', 'a.txt');
    expect(after.attrs['text']).toBe('set');
    expect(after.version).not.toBe(before.version);
  });

  it('moves version with the content, the mode and the algorithm-free pair only', async () => {
    const dir = await makeRepo({ 'a.sh': 'a\n' });
    await put(dir, 'a.sh', 'b\n');
    const first = await snap(dir, 'changes', 'a.sh');
    await put(dir, 'a.sh', 'c\n');
    const second = await snap(dir, 'changes', 'a.sh');
    expect(second.version).not.toBe(first.version);
    await chmod(join(dir, 'a.sh'), 0o755);
    expect((await snap(dir, 'changes', 'a.sh')).version).not.toBe(second.version);
  });
});

describe('binary and converted files', () => {
  it('shows a -diff path as binary with no lines, whatever its bytes are', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.lock -diff\n', 'yarn.lock': 'a\nb\n' });
    await put(dir, 'yarn.lock', 'a\nB\n');
    const s = await snap(dir, 'changes', 'yarn.lock');
    expect(s.binary).toBe(true);
    expect(s.hunks).toEqual([]);
    expect(s.old.text).toBe('');
    expect(s.new.text).toBe('');
    expect(s.old.id).not.toBe(s.new.id);

    await git(dir, 'add', 'yarn.lock');
    expect((await snap(dir, 'staged', 'yarn.lock')).binary).toBe(true);
  });

  it('shows a path marked binary as binary', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.pdf binary\n', 'a.pdf': 'a\n' });
    await put(dir, 'a.pdf', 'b\n');
    expect((await snap(dir, 'changes', 'a.pdf')).binary).toBe(true);
  });

  it('decides binary by a NUL in the first 8000 bytes, as git does', async () => {
    const dir = await makeRepo({ 'early.dat': Buffer.from('aaaa\n'), 'late.txt': Buffer.from('aaaa\n') });
    await put(dir, 'early.dat', Buffer.concat([Buffer.from('bbbb'), Buffer.from([0]), Buffer.from('\n')]));
    const early = await snap(dir, 'changes', 'early.dat');
    expect(early.binary).toBe(true);
    expect(early.hunks).toEqual([]);
    expect(early.new.text).toBe('');

    const tail = Buffer.concat([Buffer.from('b'.repeat(20000)), Buffer.from([0]), Buffer.from('\n')]);
    await put(dir, 'late.txt', tail);
    const late = await snap(dir, 'changes', 'late.txt');
    expect(late.binary).toBe(false);
    expect(late.hunks).toHaveLength(1);
  });

  it('forces text for a path with the diff attribute set', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.bin diff\n', 'a.bin': 'a\n' });
    await put(dir, 'a.bin', Buffer.from('a\0b\n'));
    const s = await snap(dir, 'changes', 'a.bin');
    expect(s.binary).toBe(false);
    expect(s.hunks).toHaveLength(1);
  });

  it('answers converted for a filter driver, without running the filter', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.big filter=lfs\n', 'a.big': 'pointer\n' });
    const marker = join(await tempDir(), 'filter-ran');
    await git(dir, 'config', 'filter.lfs.clean', `touch ${marker}; cat`);
    await git(dir, 'config', 'filter.lfs.smudge', `touch ${marker}; cat`);
    await put(dir, 'a.big', 'changed\n');
    for (const group of ['changes', 'staged'] as const) {
      const s = await snap(dir, group, 'a.big');
      expect(s.converted, group).toBe(true);
      expect(s.hunks).toEqual([]);
      expect(s.token).toBeUndefined();
      expect(s.binary).toBe(false);
    }
    await expect(stat(marker)).rejects.toThrow();
  });

  it('answers converted for a working-tree-encoding and for ident', async () => {
    const dir = await makeRepo({ 'a.u16': 'a\n', 'a.id': 'a\n' });
    // Uncommitted on purpose: committing a UTF-8 file under UTF-16 is itself an error in git.
    await put(dir, '.gitattributes', '*.u16 working-tree-encoding=UTF-16\n*.id ident\n');
    await put(dir, 'a.u16', 'b\n');
    await put(dir, 'a.id', 'b\n');
    for (const name of ['a.u16', 'a.id']) {
      const s = await snap(dir, 'changes', name);
      expect(s.converted, name).toBe(true);
      expect(s.token).toBeUndefined();
    }
  });

  it('does not call an unset or bare filter attribute converted', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.a -filter\n*.b filter\n', 'x.a': 'a\n', 'x.b': 'a\n' });
    await put(dir, 'x.a', 'b\n');
    await put(dir, 'x.b', 'b\n');
    expect((await snap(dir, 'changes', 'x.a')).converted).toBe(false);
    expect((await snap(dir, 'changes', 'x.b')).converted).toBe(false);
  });
});

describe('the size limit', () => {
  it('makes a work tree side over 1 MB tooLarge: no lines, no token, a version that moves with the file', async () => {
    const dir = await makeRepo({ 'big.txt': 'small\n' });
    await put(dir, 'big.txt', 'x'.repeat(SIDE_LIMIT_BYTES + 1));
    const s = await snap(dir, 'changes', 'big.txt');
    expect(s.tooLarge).toBe(true);
    expect(s.hunks).toEqual([]);
    expect(s.new.text).toBe('');
    expect(s.old.text).toBe('');
    expect(s.token).toBeUndefined();

    await put(dir, 'big.txt', 'y'.repeat(SIDE_LIMIT_BYTES + 1));
    await new Promise((r) => setTimeout(r, 15));
    await put(dir, 'big.txt', 'z'.repeat(SIDE_LIMIT_BYTES + 1));
    expect((await snap(dir, 'changes', 'big.txt')).version).not.toBe(s.version);
  });

  it('makes a blob side over 1 MB tooLarge, in either group', async () => {
    const dir = await makeRepo({ 'big.txt': 'x'.repeat(SIDE_LIMIT_BYTES + 1) });
    await put(dir, 'big.txt', 'small\n');
    expect((await snap(dir, 'changes', 'big.txt')).tooLarge).toBe(true);
    await git(dir, 'add', 'big.txt');
    const staged = await snap(dir, 'staged', 'big.txt');
    expect(staged.tooLarge).toBe(true);
    expect(staged.hunks).toEqual([]);
  });

  it('accepts a side of exactly 1 MB', async () => {
    const line = `${'x'.repeat(1023)}\n`;
    const dir = await makeRepo({ 'edge.txt': 'small\n' });
    await put(dir, 'edge.txt', line.repeat(1024));
    const s = await snap(dir, 'changes', 'edge.txt');
    expect(s.tooLarge).toBe(false);
    expect(s.hunks).toHaveLength(1);
    expect(s.token).toBeTruthy();
  });
});

// ── The safe work tree walk ───────────────────────────────────────────────────

describe('request paths', () => {
  it('refuses a path that escapes the project, is absolute, or holds a NUL, reading nothing', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    const outside = await tempDir();
    await put(outside, 'secret', 'TOP SECRET\n');
    const seen: string[] = [];
    setGitObserver((args) => seen.push(args[0] ?? ''));
    for (const path of ['../other/secret', join(outside, 'secret'), 'a\0b', 'a/../../secret', '']) {
      const failure = await snapFailure(dir, 'changes', path);
      expect(failure.status, path).toBe(400);
      expect(JSON.stringify(failure)).not.toContain('TOP SECRET');
    }
    expect(seen).toEqual([]);
  });

  it('refuses an oldPath that escapes the project', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    const result = await readSnapshot({ top: dir, group: 'staged', path: 'a.ts', oldPath: '../x', algorithm: 'myers' });
    expect(!result.ok && result.status).toBe(400);
  });
});

describe('the work tree walk', () => {
  /** A repository with `sub/inner/file.txt` tracked, and a directory outside it holding a decoy. */
  async function walkFixture() {
    const dir = await makeRepo({ 'sub/inner/file.txt': 'inside\n', 'sub/other.txt': 'o\n' });
    const outside = await tempDir();
    await put(outside, 'file.txt', 'OUTSIDE\n');
    await put(outside, 'secret.txt', 'TOP SECRET\n');
    return { dir, outside };
  }

  it('refuses a folder replaced by a symlink to a directory outside the project', async () => {
    const { dir, outside } = await walkFixture();
    await rm(join(dir, 'sub'), { recursive: true });
    await symlink(outside, join(dir, 'sub'));
    for (const path of ['sub/secret.txt', 'sub/inner/file.txt']) {
      const failure = await snapFailure(dir, 'changes', path);
      expect(failure.status, path).toBe(403);
      expect(failure.error).toMatch(/symbolic link/);
      expect(JSON.stringify(failure)).not.toContain('TOP SECRET');
    }
  });

  it('refuses an untracked folder replaced by a link', async () => {
    const { dir, outside } = await walkFixture();
    await symlink(outside, join(dir, 'untracked-dir'));
    const failure = await snapFailure(dir, 'changes', 'untracked-dir/secret.txt');
    expect(failure.status).toBe(403);
  });

  it('refuses when a directory is swapped for a link between two steps of the walk (regular file branch)', async () => {
    const { dir, outside } = await walkFixture();
    const steps: string[] = [];
    walkHooks.onStep = async (step) => {
      steps.push(`${step.kind}:${step.name}`);
      if (step.kind === 'dir' && step.name === 'inner') {
        await rename(join(dir, 'sub/inner'), join(dir, 'sub/inner.moved'));
        await symlink(outside, join(dir, 'sub/inner'));
      }
    };
    const failure = await snapFailure(dir, 'changes', 'sub/inner/file.txt');
    expect(steps).toEqual(['dir:sub', 'dir:inner']);
    expect(failure.status).toBe(403);
    expect(JSON.stringify(failure)).not.toContain('OUTSIDE');
  });

  it('refuses when the first directory is swapped before it is opened', async () => {
    const { dir, outside } = await walkFixture();
    walkHooks.onStep = async (step) => {
      if (step.kind === 'dir' && step.name === 'sub') {
        await rename(join(dir, 'sub'), join(dir, 'sub.moved'));
        await symlink(outside, join(dir, 'sub'));
      }
    };
    expect((await snapFailure(dir, 'changes', 'sub/inner/file.txt')).status).toBe(403);
  });

  it('keeps reading the directory it already holds when a later swap happens (regular file branch)', async () => {
    const { dir, outside } = await walkFixture();
    walkHooks.onStep = async (step) => {
      if (step.kind === 'file') {
        await rename(join(dir, 'sub/inner'), join(dir, 'sub/inner.moved'));
        await symlink(outside, join(dir, 'sub/inner'));
      }
    };
    const s = await snap(dir, 'changes', 'sub/inner/file.txt');
    expect(s.new.text).toBe('inside\n');
    expect(JSON.stringify(s)).not.toContain('OUTSIDE');
  });

  it('refuses a swap between steps in the symlink branch', async () => {
    const { dir, outside } = await walkFixture();
    await symlink('original-target', join(dir, 'sub/inner/ln'));
    await symlink('OUTSIDE-TARGET', join(outside, 'ln'));
    walkHooks.onStep = async (step) => {
      if (step.kind === 'dir' && step.name === 'inner') {
        await rename(join(dir, 'sub/inner'), join(dir, 'sub/inner.moved'));
        await symlink(outside, join(dir, 'sub/inner'));
      }
    };
    const failure = await snapFailure(dir, 'changes', 'sub/inner/ln');
    expect(failure.status).toBe(403);
    expect(JSON.stringify(failure)).not.toContain('OUTSIDE');
  });

  it('reads the link it already holds the parent of when a later swap happens (symlink branch)', async () => {
    const { dir, outside } = await walkFixture();
    await symlink('original-target', join(dir, 'sub/inner/ln'));
    await symlink('OUTSIDE-TARGET', join(outside, 'ln'));
    walkHooks.onStep = async (step) => {
      if (step.kind === 'file') {
        await rename(join(dir, 'sub/inner'), join(dir, 'sub/inner.moved'));
        await symlink(outside, join(dir, 'sub/inner'));
      }
    };
    const s = await snap(dir, 'changes', 'sub/inner/ln');
    expect(s.new.text).toBe('original-target');
    expect(s.symlink).toEqual({ new: true });
    expect(JSON.stringify(s)).not.toContain('OUTSIDE');
  });

  it('answers a missing intermediate directory as an absent file, not an error', async () => {
    const { dir } = await walkFixture();
    await rm(join(dir, 'sub'), { recursive: true });
    const s = await snap(dir, 'changes', 'sub/inner/file.txt');
    expect(s.new.id).toBe('absent');
    expect(s.old.text).toBe('inside\n');
  });

  it('refuses a FIFO without waiting for a writer', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    await exec('mkfifo', [join(dir, 'pipe')]);
    const started = Date.now();
    const failure = await snapFailure(dir, 'changes', 'pipe');
    expect(failure.status).toBe(400);
    expect(failure.error).toMatch(/regular file/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('fails closed without /proc for the work tree, while staged diffs still work', async () => {
    const dir = await makeRepo({ 'a.ts': 'one\n' });
    await put(dir, 'a.ts', 'two\n');
    await git(dir, 'add', 'a.ts');
    await put(dir, 'a.ts', 'three\n');
    walkHooks.procFdDir = join(dir, 'no-proc-here');

    const failure = await snapFailure(dir, 'changes', 'a.ts');
    expect(failure.status).toBe(501);
    expect(failure.code).toBe('unsupported');
    expect(failure.error).toMatch(/cannot read the work tree safely/);

    const staged = await snap(dir, 'staged', 'a.ts');
    expect(staged.new.text).toBe('two\n');
  });

  it('refuses a submodule entry', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    const inner = await makeRepo({ 'x.txt': 'x\n' });
    const head = (await git(inner, 'rev-parse', 'HEAD')).trim();
    await git(dir, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/inner`);
    const failure = await snapFailure(dir, 'staged', 'vendor/inner');
    expect(failure.code).toBe('unsupported');
  });
});

// ── The attribute context staging compares ────────────────────────────────────

describe('readAttrContext', () => {
  it('reads the attribute and conversion inputs for one path', async () => {
    const dir = await makeRepo({ '.gitattributes': '*.txt text eol=lf\n', 'a.txt': 'a\n' });
    await git(dir, 'config', 'core.autocrlf', 'input');
    const result = await readAttrContext(dir, 'a.txt');
    expect(result.ok && result.context).toMatchObject({
      text: 'set',
      eol: 'lf',
      'core.autocrlf': 'input',
      'core.eol': 'unset',
    });
    expect(result.ok && 'convert' in result.context).toBe(false);
  });
});

// ── The token and receipt cache ───────────────────────────────────────────────

describe('the token cache', () => {
  const record = (path: string, size = 10) => ({
    top: '/repo',
    path,
    mode: '100644',
    id: 'a'.repeat(40),
    bytes: Buffer.alloc(size),
    context: {},
  });

  it('finds a token and refuses a receipt id in its place', () => {
    const token = putToken(record('a.ts'));
    expect(getToken(token)?.path).toBe('a.ts');
    expect(getReceipt(token)).toBeUndefined();
    const receipt = putReceipt({ top: '/repo', entries: [] });
    expect(getReceipt(receipt)).toEqual({ top: '/repo', entries: [] });
    expect(getToken(receipt)).toBeUndefined();
    expect(getToken('nonsense')).toBeUndefined();
  });

  it('expires a token after ten minutes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = putToken(record('a.ts'));
    vi.setSystemTime(new Date('2026-01-01T00:09:59Z'));
    expect(getToken(token)).toBeDefined();
    vi.setSystemTime(new Date('2026-01-01T00:10:01Z'));
    expect(getToken(token)).toBeUndefined();
    expect(scmCacheStats().entries).toBe(0);
  });

  it('evicts the least recently used past the byte bound', () => {
    configureScmCache({ maxBytes: 3000 });
    const first = putToken(record('first', 800));
    const second = putToken(record('second', 800));
    expect(getToken(first)).toBeDefined();
    const third = putToken(record('third', 800));
    // `second` was the least recently used.
    expect(getToken(second)).toBeUndefined();
    expect(getToken(first)).toBeDefined();
    expect(getToken(third)).toBeDefined();
    expect(scmCacheStats().bytes).toBeLessThanOrEqual(3000);
  });

  it('is filled by a snapshot and holds the canonical bytes, not a path', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' });
    await writeFile(join(dir, '.gitattributes'), 'a.txt text eol=crlf\n');
    await put(dir, 'a.txt', 'two\r\n');
    const s = await snap(dir, 'changes', 'a.txt');
    const held = getToken(s.token as string);
    expect(held).toMatchObject({ top: dir, path: 'a.txt', mode: '100644', id: s.new.id });
    expect(held?.bytes.toString()).toBe('two\n');
    expect(held?.context['eol']).toBe('crlf');
    // Editing the file afterwards does not change what the token holds.
    await put(dir, 'a.txt', 'changed again\r\n');
    expect(getToken(s.token as string)?.bytes.toString()).toBe('two\n');
    expect((await readFile(join(dir, 'a.txt'))).toString()).toBe('changed again\r\n');
  });
});
