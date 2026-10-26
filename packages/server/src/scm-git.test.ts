// The git runner and the request checks, against throwaway repositories in os.tmpdir().

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  checkRelPath,
  checkRepo,
  parseLsFiles,
  parseLsTree,
  readHead,
  readHeadEntry,
  resolveRepo,
  runGit,
  setGitObserver,
} from './scm-git';

const exec = promisify(execFile);

let home: string;
let savedHome: string | undefined;
const created: string[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'palmux-scm-home-'));
  await writeFile(
    join(home, '.gitconfig'),
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  savedHome = process.env['HOME'];
  process.env['HOME'] = home;
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  await Promise.all([home, ...created].map((dir) => rm(dir, { recursive: true, force: true })));
});

afterEach(() => {
  setGitObserver(null);
  delete process.env['GIT_DIFF_OPTS'];
  delete process.env['GIT_DIR'];
  delete process.env['GIT_INDEX_FILE'];
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout;
}

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'palmux-scm-git-')));
  created.push(dir);
  return dir;
}

async function put(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content);
}

async function makeRepo(files: Record<string, string> = {}, commit = true): Promise<string> {
  const dir = await tempDir();
  await git(dir, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
  if (commit) {
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

describe('runGit', () => {
  it('runs a command and returns its output', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    const run = await runGit(dir, ['rev-parse', '--show-toplevel']);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.stdout.toString().trim()).toBe(dir);
  });

  it('kills a hanging command at the timeout', async () => {
    const dir = await tempDir();
    const started = Date.now();
    const run = await runGit(dir, ['-c', 'alias.hang=!sleep 20', 'hang'], { timeoutMs: 300 });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports an oversized output as truncated and keeps what fit', async () => {
    const dir = await tempDir();
    const run = await runGit(dir, ['-c', 'alias.big=!head -c 200000 /dev/zero', 'big'], {
      maxBuffer: 1000,
    });
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.reason).toBe('truncated');
      expect(run.stdout.length).toBe(1000);
    }
  });

  it('treats an exit code listed in okCodes as success and any other as a failure', async () => {
    const dir = await makeRepo({}, false);
    const unborn = await runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] });
    expect(unborn.ok).toBe(true);
    if (unborn.ok) expect(unborn.code).toBe(1);
    const strict = await runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.reason).toBe('exit');
  });

  it('reports a process that cannot start', async () => {
    const dir = await tempDir();
    const nul = await runGit(dir, ['rev-parse', 'a\0b']);
    expect(nul.ok).toBe(false);
    if (!nul.ok) expect(nul.reason).toBe('spawn');

    const savedPath = process.env['PATH'];
    process.env['PATH'] = join(dir, 'no-such-bin');
    try {
      const noGit = await runGit(dir, ['status']);
      expect(noGit.ok).toBe(false);
      if (!noGit.ok) expect(noGit.reason).toBe('spawn');
    } finally {
      process.env['PATH'] = savedPath;
    }
  });

  it('reports a missing working directory as a failed command', async () => {
    const run = await runGit(join(tmpdir(), 'palmux-does-not-exist-xyz'), ['status']);
    expect(run.ok).toBe(false);
  });

  it('feeds stdin', async () => {
    const dir = await makeRepo({}, false);
    const run = await runGit(dir, ['hash-object', '--stdin'], { input: 'hello\n' });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.stdout.toString().trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('builds a clean environment: no inherited GIT_*, the safety variables set', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    process.env['GIT_DIFF_OPTS'] = '-u1';
    process.env['GIT_DIR'] = '/nonexistent';
    process.env['GIT_INDEX_FILE'] = '/nonexistent/index';
    process.env['GIT_WORK_TREE'] = '/nonexistent';
    process.env['GIT_CONFIG_PARAMETERS'] = "'diff.noprefix=true'";
    try {
      const run = await runGit(dir, ['-c', 'alias.dumpenv=!env', 'dumpenv']);
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      const lines = run.stdout.toString().split('\n');
      for (const expected of [
        'GIT_OPTIONAL_LOCKS=0',
        'GIT_LITERAL_PATHSPECS=1',
        'GIT_TERMINAL_PROMPT=0',
        'LC_ALL=C',
        `HOME=${home}`,
      ]) {
        expect(lines).toContain(expected);
      }
      for (const forbidden of ['GIT_DIFF_OPTS', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) {
        expect(lines.some((l) => l.startsWith(`${forbidden}=`))).toBe(false);
      }
      // git rebuilds this one from its own -c flags; the poisoned value must not survive in it.
      const parameters = lines.find((l) => l.startsWith('GIT_CONFIG_PARAMETERS=')) ?? '';
      expect(parameters).toContain('core.quotepath');
      expect(parameters).not.toContain('diff.noprefix');
      // The repository is still the one named by -C, not the poisoned GIT_DIR.
      expect(lines).not.toContain('GIT_DIR=/nonexistent');
    } finally {
      delete process.env['GIT_WORK_TREE'];
      delete process.env['GIT_CONFIG_PARAMETERS'];
    }
  });

  it('takes literal pathspecs: a name with a glob is that name only', async () => {
    const dir = await makeRepo({ 'a*.ts': '1\n', 'alpha.ts': '2\n' });
    const run = await runGit(dir, ['ls-files', '-z', '--', 'a*.ts']);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.stdout.toString()).toBe('a*.ts\0');
  });

  it('shows every started command to an observer', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' });
    const seen: string[] = [];
    setGitObserver((args) => seen.push(args[0] ?? ''));
    await runGit(dir, ['rev-parse', '--show-toplevel']);
    await runGit(dir, ['ls-files']);
    expect(seen).toEqual(['rev-parse', 'ls-files']);
  });
});

describe('resolveRepo and checkRepo', () => {
  it('answers the canonical top of a work tree, from the root or a subfolder', async () => {
    const dir = await makeRepo({ 'src/deep/a.ts': 'a\n' });
    expect(await resolveRepo(dir)).toEqual({ ok: true, top: dir });
    expect(await resolveRepo(join(dir, 'src', 'deep'))).toEqual({ ok: true, top: dir });
  });

  it('resolves a symlinked path to the canonical form', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    const holder = await tempDir();
    await symlink(dir, join(holder, 'link'));
    expect(await resolveRepo(join(holder, 'link'))).toEqual({ ok: true, top: dir });
  });

  it('refuses a plain folder, naming the reason', async () => {
    const plain = await tempDir();
    const result = await resolveRepo(plain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/not a git repository/);
    }
  });

  it('refuses relative, missing, blank, NUL, file and leading-space paths', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    const cases: [unknown, RegExp][] = [
      ['relative/path', /absolute/],
      [join(dir, 'missing'), /does not exist/],
      ['', /required/],
      ['   ', /required/],
      [undefined, /required/],
      [`${dir}\0x`, /NUL/],
      [join(dir, 'a.ts'), /not a directory/],
      [` ${dir}`, /absolute/],
    ];
    for (const [value, message] of cases) {
      const result = await resolveRepo(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toMatch(message);
      }
    }
  });

  it('refuses the inside of the .git directory', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' });
    const result = await resolveRepo(join(dir, '.git'));
    expect(result.ok).toBe(false);
  });

  it('pins a request to the top level: a subfolder or a trailing slash is not the repo', async () => {
    const dir = await makeRepo({ 'src/a.ts': 'a\n' });
    expect(await checkRepo(dir)).toEqual({ ok: true, top: dir });
    for (const value of [join(dir, 'src'), `${dir}/`]) {
      const result = await checkRepo(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/top level/);
    }
    expect((await checkRepo('relative')).ok).toBe(false);
  });
});

describe('checkRelPath', () => {
  it('accepts a path exactly as given, including pattern characters and spaces', () => {
    for (const path of ['a.ts', 'src/deep/a.ts', 'a*.ts', '2:config.ts', ':(glob)x', 'report ', ' lead', 'a b/c d']) {
      expect(checkRelPath(path)).toEqual({ ok: true, path });
    }
  });

  it('refuses what could leave the repository or is not a path', () => {
    const bad: unknown[] = [
      '',
      '   ',
      undefined,
      42,
      '/etc/passwd',
      '../other/secret',
      'a/../b',
      'a/..',
      './a',
      'a/./b',
      'a//b',
      'a/',
      'a\0b',
      '.git/config',
      'sub/.GIT/hooks/post-commit',
    ];
    for (const value of bad) {
      const result = checkRelPath(value);
      expect(result.ok, String(value)).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it('names the field it checked', () => {
    const result = checkRelPath('/x', 'oldPath');
    expect(!result.ok && result.error).toMatch(/^oldPath /);
  });
});

describe('ls parsers', () => {
  it('parses ls-files -s -z records, including a name with a tab or a newline', () => {
    const buf = Buffer.from(
      '100644 aaaa 0\ta.ts\x00100755 bbbb 2\tweird\tname\nx\x00120000 cccc 0\tlink\x00',
    );
    expect(parseLsFiles(buf)).toEqual([
      { mode: '100644', oid: 'aaaa', stage: 0, path: 'a.ts' },
      { mode: '100755', oid: 'bbbb', stage: 2, path: 'weird\tname\nx' },
      { mode: '120000', oid: 'cccc', stage: 0, path: 'link' },
    ]);
  });

  it('parses ls-tree -z records', () => {
    const buf = Buffer.from('100644 blob aaaa\ta.ts\x00040000 tree bbbb\tdir\x00160000 commit cccc\tsub\x00');
    expect(parseLsTree(buf)).toEqual([
      { mode: '100644', type: 'blob', oid: 'aaaa', path: 'a.ts' },
      { mode: '040000', type: 'tree', oid: 'bbbb', path: 'dir' },
      { mode: '160000', type: 'commit', oid: 'cccc', path: 'sub' },
    ]);
  });
});

describe('HEAD reads', () => {
  it('reports an unborn HEAD as no commit and never asks ls-tree', async () => {
    const dir = await makeRepo({}, false);
    const seen: string[] = [];
    setGitObserver((args) => seen.push(args[0] ?? ''));
    expect(await readHead(dir)).toEqual({ ok: true, oid: null });
    expect(await readHeadEntry(dir, 'a.ts')).toEqual({ ok: true, entry: null });
    expect(seen).not.toContain('ls-tree');
  });

  it('finds the blob at exactly the named path, never a pattern or a neighbour', async () => {
    const dir = await makeRepo({
      'a*.ts': 'star\n',
      'alpha.ts': 'alpha\n',
      '2:config.ts': 'colon\n',
      'dir/x.ts': 'x\n',
    });
    const star = await readHeadEntry(dir, 'a*.ts');
    expect(star.ok && star.entry?.path).toBe('a*.ts');
    expect(star.ok && star.entry?.oid).toBe((await git(dir, 'hash-object', 'a*.ts')).trim());
    const colon = await readHeadEntry(dir, '2:config.ts');
    expect(colon.ok && colon.entry?.oid).toBe((await git(dir, 'hash-object', '2:config.ts')).trim());
    const nested = await readHeadEntry(dir, 'dir/x.ts');
    expect(nested.ok && nested.entry?.mode).toBe('100644');
  });

  it('treats a directory, a missing path and a glob that only a pattern would match as absent', async () => {
    const dir = await makeRepo({ 'alpha.ts': 'alpha\n', 'dir/x.ts': 'x\n' });
    for (const path of ['dir', 'missing.ts', 'a*.ts', 'dir/*']) {
      expect(await readHeadEntry(dir, path), path).toEqual({ ok: true, entry: null });
    }
  });
});
