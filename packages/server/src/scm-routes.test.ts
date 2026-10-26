// The /scm routes end to end: each one's happy path and its refusals, against
// throwaway repositories. The git behaviour itself is pinned in the scm-*.test.ts
// beside each module; this file pins what the HTTP surface adds: the cookie gate,
// the repo check on every request, JSON errors with the module's status and code,
// the shared status answer staying unmodified, and the comment-rev broadcast.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import type {
  ScmCommentInput,
  ScmCommentList,
  ScmError,
  ScmFileSnapshot,
  ScmStatus,
  ScmWriteResult,
  ServerMessage,
} from '@palmux/shared';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import { createServer, createSessionRegistry } from './server';
import { resetScmCache } from './scm-snapshot';
import { memoryGroupsStore, memoryTabsStore } from './tabs-store';
import { memoryRestoreStore } from './session-restore';

const exec = promisify(execFile);
const secret = 'b'.repeat(64);
const cookie = `${SESSION_COOKIE}=${secret}`;
const gitConfig =
  '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n';

const ENV_KEYS = ['HOME', 'PALMUX_CONFIG_DIR', 'TMPDIR', 'TMUX_TMPDIR', 'XDG_CONFIG_HOME'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const scratchDirs: string[] = [];

let app: FastifyInstance;
let port: number;
let home: string;
let configDir: string;
let scratch: string;

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  home = await mkdtemp(join(tmpdir(), 'palmux-scmroutes-home-'));
  configDir = await mkdtemp(join(tmpdir(), 'palmux-scmroutes-cfg-'));
  // A private TMPDIR keeps the snapshot reader's scratch directories out of the real /tmp.
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'palmux-scmroutes-tmp-')));
  const tmuxDir = await mkdtemp(join(tmpdir(), 'palmux-scmroutes-tmux-'));
  scratchDirs.push(home, configDir, scratch, tmuxDir);
  await writeFile(join(home, '.gitconfig'), gitConfig);
  process.env['HOME'] = home;
  process.env['PALMUX_CONFIG_DIR'] = configDir;
  process.env['TMPDIR'] = scratch;
  process.env['TMUX_TMPDIR'] = tmuxDir;
  delete process.env['XDG_CONFIG_HOME'];

  // Auth ON, so the tests also prove the cookie gate covers every /scm route.
  const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: true };
  const registry = createSessionRegistry(
    cfg,
    memoryTabsStore(),
    memoryGroupsStore(),
    undefined,
    memoryRestoreStore(),
  );
  app = await createServer(cfg, secret, registry);
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  await app.close();
  resetScmCache();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

async function put(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content);
}

async function makeRepo(files: Record<string, string> = { 'a.txt': 'one\ntwo\nthree\n' }) {
  const dir = await tempDir();
  await git(dir, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const indexListing = (dir: string) => git(dir, 'ls-files', '-s');
const stagedNames = async (dir: string) =>
  (await git(dir, 'diff', '--cached', '--name-only')).split('\n').filter(Boolean);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function route(path: string, params: Record<string, string> = {}): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return query === '' ? path : `${path}?${query}`;
}

function call(
  method: Method,
  url: string,
  payload?: object | string,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}

const body = <T>(res: LightMyRequestResponse): T => res.json<T>();

/** The refusal shape every /scm route answers with. */
function expectRefusal(res: LightMyRequestResponse, status: number, code?: string): ScmError {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toContain('application/json');
  const error = body<ScmError>(res);
  expect(typeof error.error).toBe('string');
  expect(error.error).not.toBe('');
  expect(error.code).toBe(code);
  return error;
}

async function statusOf(repo: string): Promise<ScmStatus> {
  const res = await call('GET', route('/scm/status', { repo }));
  expect(res.statusCode, res.body).toBe(200);
  return body<ScmStatus>(res);
}

async function snapshotOf(
  repo: string,
  path: string,
  group: 'staged' | 'changes' = 'changes',
): Promise<ScmFileSnapshot> {
  const res = await call('GET', route('/scm/file', { repo, group, path, algorithm: 'histogram' }));
  expect(res.statusCode, res.body).toBe(200);
  return body<ScmFileSnapshot>(res);
}

async function stage(repo: string, path: string): Promise<ScmWriteResult> {
  const token = (await snapshotOf(repo, path)).token;
  expect(token).toBeTypeOf('string');
  const res = await call('POST', route('/scm/stage', { repo }), { path, token });
  expect(res.statusCode, res.body).toBe(200);
  return body<ScmWriteResult>(res);
}

const comment = (over: Partial<ScmCommentInput> = {}): ScmCommentInput => ({
  path: 'a.txt',
  version: 'worktree',
  side: 'new',
  start: 2,
  end: 2,
  lines: ['two'],
  before: ['one'],
  after: ['three'],
  body: 'rename this',
  ...over,
});

// ── A control socket, for the scmComments frame ───────────────────────────────

interface Listener {
  ws: WebSocket;
  frames: ServerMessage[];
}

function listen(): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?control=1`, { headers: { cookie } });
    const frames: ServerMessage[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) frames.push(JSON.parse(data.toString()) as ServerMessage);
    });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
  });
}

const revFrames = (l: Listener) =>
  l.frames.flatMap((f) => (f.type === 'scmComments' ? [{ repo: f.repo, rev: f.rev }] : []));

/** A pong means every frame sent to this socket before it has been delivered. */
async function settled(l: Listener): Promise<void> {
  const seen = l.frames.filter((f) => f.type === 'pong').length;
  l.ws.send(JSON.stringify({ type: 'ping' }));
  await vi.waitFor(
    () => {
      if (l.frames.filter((f) => f.type === 'pong').length <= seen) throw new Error('no pong yet');
    },
    { timeout: 4000, interval: 10 },
  );
}

// ── The gate and the unknown paths ────────────────────────────────────────────

describe('the cookie gate and unknown /scm paths', () => {
  it('answers 401 to every route without the session cookie', async () => {
    const dir = await makeRepo();
    const calls: [Method, string][] = [
      ['GET', route('/scm/repo', { path: dir })],
      ['GET', route('/scm/status', { repo: dir })],
      [
        'GET',
        route('/scm/file', { repo: dir, group: 'changes', path: 'a.txt', algorithm: 'myers' }),
      ],
      ['GET', route('/scm/comments', { repo: dir })],
      ['POST', route('/scm/comments', { repo: dir })],
      ['PATCH', route('/scm/comments', { repo: dir, id: 'x' })],
      ['DELETE', route('/scm/comments', { repo: dir, id: 'x' })],
      ['POST', route('/scm/stage', { repo: dir })],
      ['POST', route('/scm/unstage', { repo: dir })],
      ['POST', route('/scm/restore', { repo: dir })],
    ];
    for (const [method, url] of calls) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('answers an unknown /scm path or method with a JSON 404, never the app shell', async () => {
    for (const [method, url] of [
      ['GET', '/scm/nope'],
      ['POST', '/scm/status'],
      ['GET', '/scm/stage'],
      ['DELETE', '/scm/file'],
    ] as const) {
      const res = await call(method, url, undefined, { accept: 'text/html' });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).not.toContain('<html');
    }
  });
});

// ── GET /scm/repo ─────────────────────────────────────────────────────────────

describe('GET /scm/repo', () => {
  it('answers the canonical top of a subfolder', async () => {
    const dir = await makeRepo({ 'src/app.ts': 'x\n' });
    const res = await call('GET', route('/scm/repo', { path: join(dir, 'src') }));
    expect(res.statusCode).toBe(200);
    expect(body<{ top: string }>(res)).toEqual({ top: dir });
  });

  it('refuses a relative path, a plain folder, a missing path and an absent parameter', async () => {
    const plain = await tempDir();
    expectRefusal(await call('GET', route('/scm/repo', { path: 'work/app' })), 400);
    expect(
      expectRefusal(await call('GET', route('/scm/repo', { path: plain })), 400).error,
    ).toMatch(/not (a git repository|inside a git work tree)/);
    expectRefusal(await call('GET', route('/scm/repo', { path: join(plain, 'gone') })), 400);
    expectRefusal(await call('GET', '/scm/repo'), 400);
    expectRefusal(await call('GET', route('/scm/repo', { path: ' ' })), 400);
  });
});

// ── GET /scm/status ───────────────────────────────────────────────────────────

describe('GET /scm/status', () => {
  it('answers every group, the comments rev and the attribute epoch', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n', 'b.txt': 'one\n' });
    await put(dir, 'a.txt', 'one\ntwo\n'); // Changes: modified
    await put(dir, 'new.txt', 'hello\n');
    await git(dir, 'add', 'new.txt'); // Staged: added
    await put(dir, 'loose/c.txt', 'x\n'); // Changes: untracked
    const status = await statusOf(dir);
    expect(status.top).toBe(dir);
    expect(status.unborn).toBe(false);
    expect(status.branch).toBe('main');
    expect(status.staged.map((e) => [e.path, e.status])).toEqual([['new.txt', 'A']]);
    expect(status.changes.map((e) => [e.path, e.status]).toSorted()).toEqual([
      ['a.txt', 'M'],
      ['loose/c.txt', '?'],
    ]);
    expect(status.merge).toEqual([]);
    expect(status.truncated).toBe(false);
    expect(status.commentsRev).toBe(0);
    expect(status.attrEpoch).toBeTypeOf('string');
  });

  it('refuses a relative repo, a subfolder of one, a plain folder and a missing parameter', async () => {
    const dir = await makeRepo({ 'src/app.ts': 'x\n' });
    const plain = await tempDir();
    expectRefusal(await call('GET', route('/scm/status', { repo: 'work/app' })), 400);
    const sub = expectRefusal(
      await call('GET', route('/scm/status', { repo: join(dir, 'src') })),
      400,
    );
    expect(sub.error).toContain(dir);
    expectRefusal(await call('GET', route('/scm/status', { repo: plain })), 400);
    expectRefusal(await call('GET', '/scm/status'), 400);
  });

  it('reports the current comments rev even from a cached status answer', async () => {
    const dir = await makeRepo();
    const first = await statusOf(dir);
    expect(first.commentsRev).toBe(0);
    const added = await call('POST', route('/scm/comments', { repo: dir }), comment());
    expect(added.statusCode, added.body).toBe(200);
    // Inside the 500 ms status cache, so this answer is the same object's content plus the newer rev.
    const second = await statusOf(dir);
    expect(second.commentsRev).toBe(1);
    expect(second.tookMs).toBe(first.tookMs);
  });
});

// ── GET /scm/file ─────────────────────────────────────────────────────────────

describe('GET /scm/file', () => {
  it('answers a snapshot of an unstaged edit, with git’s hunks and a staging token', async () => {
    const dir = await makeRepo();
    await put(dir, 'a.txt', 'one\nTWO\nthree\n');
    const snap = await snapshotOf(dir, 'a.txt');
    expect(snap.group).toBe('changes');
    expect(snap.old.text).toBe('one\ntwo\nthree\n');
    expect(snap.new.text).toBe('one\nTWO\nthree\n');
    expect(snap.hunks).toHaveLength(1);
    expect(
      snap.hunks[0]?.lines.filter((l) => l.kind !== 'ctx').map((l) => [l.kind, l.text]),
    ).toEqual([
      ['del', 'two'],
      ['add', 'TWO'],
    ]);
    expect(snap.token).toBeTypeOf('string');
  });

  it('answers the staged pair for the staged group', async () => {
    const dir = await makeRepo();
    await put(dir, 'a.txt', 'one\nTWO\nthree\n');
    await git(dir, 'add', 'a.txt');
    const snap = await snapshotOf(dir, 'a.txt', 'staged');
    expect(snap.group).toBe('staged');
    expect(snap.old.text).toBe('one\ntwo\nthree\n');
    expect(snap.new.text).toBe('one\nTWO\nthree\n');
  });

  it('reads a file named like a pattern literally', async () => {
    const dir = await makeRepo({ 'a*.ts': 'star\n', 'alpha.ts': 'alpha\n' });
    await put(dir, 'a*.ts', 'star edited\n');
    await put(dir, 'alpha.ts', 'alpha edited\n');
    const snap = await snapshotOf(dir, 'a*.ts');
    expect(snap.new.text).toBe('star edited\n');
    expect(snap.hunks.flatMap((h) => h.lines.map((l) => l.text)).join('|')).not.toContain('alpha');
  });

  it('refuses an escaping, absolute, NUL or missing path', async () => {
    const dir = await makeRepo();
    const base = { repo: dir, group: 'changes', algorithm: 'histogram' };
    for (const path of [
      '../other/secret',
      'sub/../../x',
      '/etc/passwd',
      'a\0b',
      '',
      '.git/config',
    ]) {
      expectRefusal(await call('GET', route('/scm/file', { ...base, path })), 400);
    }
    expectRefusal(await call('GET', route('/scm/file', base)), 400);
  });

  it('refuses a bad group, a bad or absent algorithm and a bad repo', async () => {
    const dir = await makeRepo();
    const path = 'a.txt';
    expectRefusal(
      await call(
        'GET',
        route('/scm/file', { repo: dir, group: 'merge', path, algorithm: 'myers' }),
      ),
      400,
    );
    expectRefusal(
      await call(
        'GET',
        route('/scm/file', { repo: dir, group: 'changes', path, algorithm: 'fast' }),
      ),
      400,
    );
    expectRefusal(
      await call('GET', route('/scm/file', { repo: dir, group: 'changes', path })),
      400,
    );
    expectRefusal(
      await call(
        'GET',
        route('/scm/file', { repo: 'work', group: 'changes', path, algorithm: 'myers' }),
      ),
      400,
    );
    expectRefusal(
      await call(
        'GET',
        route('/scm/file', { repo: join(dir, 'x'), group: 'changes', path, algorithm: 'myers' }),
      ),
      400,
    );
  });

  it('reads nothing through a folder that is a symbolic link to outside the project', async () => {
    const dir = await makeRepo();
    const outside = await tempDir();
    await put(outside, 'secret.txt', 'TOPSECRET\n');
    await symlink(outside, join(dir, 'link'));
    const res = await call(
      'GET',
      route('/scm/file', {
        repo: dir,
        group: 'changes',
        path: 'link/secret.txt',
        algorithm: 'histogram',
      }),
    );
    expectRefusal(res, 403);
    expect(res.body).not.toContain('TOPSECRET');
  });
});

// ── /scm/comments ─────────────────────────────────────────────────────────────

describe('/scm/comments', () => {
  it('answers an empty list first, then the whole list and its rev for every write', async () => {
    const dir = await makeRepo();
    const empty = await call('GET', route('/scm/comments', { repo: dir }));
    expect(body<ScmCommentList>(empty)).toEqual({ rev: 0, comments: [] });

    const created = body<ScmCommentList>(
      await call('POST', route('/scm/comments', { repo: dir }), comment()),
    );
    expect(created.rev).toBe(1);
    expect(created.comments).toHaveLength(1);
    const id = created.comments[0]?.id as string;
    expect(created.comments[0]).toMatchObject({ path: 'a.txt', body: 'rename this', start: 2 });

    const patched = await call('PATCH', route('/scm/comments', { repo: dir, id }), {
      body: 'rename that',
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(body<ScmCommentList>(patched).rev).toBe(2);
    expect(body<ScmCommentList>(patched).comments[0]).toMatchObject({ id, body: 'rename that' });

    const deleted = body<ScmCommentList>(
      await call('DELETE', route('/scm/comments', { repo: dir, id })),
    );
    expect(deleted).toEqual({ rev: 3, comments: [] });
    expect(body<ScmCommentList>(await call('GET', route('/scm/comments', { repo: dir })))).toEqual(
      deleted,
    );
  });

  it('keeps both changes of two interleaved writers', async () => {
    const dir = await makeRepo();
    const post = (text: string) =>
      call('POST', route('/scm/comments', { repo: dir }), comment({ body: text }));
    const [x, y] = await Promise.all([post('x'), post('y')]);
    const xId = body<ScmCommentList>(x).comments.find((c) => c.body === 'x')?.id;
    const yId = body<ScmCommentList>(y).comments.find((c) => c.body === 'y')?.id;
    expect(xId ?? yId).toBeDefined();

    // A create and a delete of a different comment, at the same moment.
    const [added, removed] = await Promise.all([
      post('z'),
      call('DELETE', route('/scm/comments', { repo: dir, id: (xId ?? yId) as string })),
    ]);
    expect([added.statusCode, removed.statusCode]).toEqual([200, 200]);
    const final = body<ScmCommentList>(await call('GET', route('/scm/comments', { repo: dir })));
    expect(final.rev).toBe(4);
    const bodies = final.comments.map((c) => c.body).toSorted();
    expect(bodies).toHaveLength(2);
    expect(bodies).toContain('z');
    expect(bodies).not.toContain(xId === undefined ? 'y' : 'x');
  });

  it('broadcasts scmComments { repo, rev } to every client after each write, and only then', async () => {
    const dir = await makeRepo();
    const other = await makeRepo();
    const a = await listen();
    const b = await listen();
    try {
      const created = body<ScmCommentList>(
        await call('POST', route('/scm/comments', { repo: dir }), comment()),
      );
      const id = created.comments[0]?.id as string;
      await call('PATCH', route('/scm/comments', { repo: dir, id }), { body: 'again' });
      await call('DELETE', route('/scm/comments', { repo: dir, id }));
      await call('POST', route('/scm/comments', { repo: other }), comment());
      // Refusals write nothing and say nothing.
      await call('POST', route('/scm/comments', { repo: dir }), comment({ lines: [] }));
      await call('PATCH', route('/scm/comments', { repo: dir, id: 'gone' }), { body: 'x' });
      await call('GET', route('/scm/comments', { repo: dir }));
      await Promise.all([settled(a), settled(b)]);
      const expected = [
        { repo: dir, rev: 1 },
        { repo: dir, rev: 2 },
        { repo: dir, rev: 3 },
        { repo: other, rev: 1 },
      ];
      expect(revFrames(a)).toEqual(expected);
      expect(revFrames(b)).toEqual(expected);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });

  it('keeps the repository clean and the store behind a .cache/.gitignore', async () => {
    const dir = await makeRepo();
    for (const text of ['one', 'two', 'three']) {
      await call('POST', route('/scm/comments', { repo: dir }), comment({ body: text }));
    }
    expect(await git(dir, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(configDir, '.cache', '.gitignore'), 'utf8')).toBe('*\n');
    expect((await stat(join(configDir, '.cache', 'scm'))).isDirectory()).toBe(true);
  });

  it('refuses a relative or non-top repo on every verb', async () => {
    const dir = await makeRepo({ 'src/app.ts': 'x\n' });
    for (const repo of ['work/app', join(dir, 'src')]) {
      const params = { repo, id: 'x' };
      expectRefusal(await call('GET', route('/scm/comments', params)), 400);
      expectRefusal(await call('POST', route('/scm/comments', params), comment()), 400);
      expectRefusal(await call('PATCH', route('/scm/comments', params), { body: 'x' }), 400);
      expectRefusal(await call('DELETE', route('/scm/comments', params)), 400);
    }
    expectRefusal(await call('GET', '/scm/comments'), 400);
  });

  it('refuses an invalid comment, a missing or unknown id, and an empty patch', async () => {
    const dir = await makeRepo();
    const url = (params: Record<string, string> = {}) =>
      route('/scm/comments', { repo: dir, ...params });
    // Lines that do not cover the range.
    expectRefusal(await call('POST', url(), comment({ start: 2, end: 4, lines: ['two'] })), 400);
    expectRefusal(await call('POST', url(), comment({ path: '../x' })), 400);
    expectRefusal(await call('POST', url(), { ...comment(), version: 'tomorrow' }), 400);
    // Not a JSON object at all.
    expectRefusal(await call('POST', url(), '[]', { 'content-type': 'application/json' }), 400);
    expectRefusal(await call('POST', url(), 'plain text', { 'content-type': 'text/plain' }), 400);

    const created = body<ScmCommentList>(await call('POST', url(), comment()));
    const id = created.comments[0]?.id as string;
    expectRefusal(await call('PATCH', url(), { body: 'x' }), 400); // no id
    expectRefusal(await call('DELETE', url()), 400); // no id
    expectRefusal(await call('PATCH', url({ id: 'gone' }), { body: 'x' }), 404);
    expectRefusal(await call('PATCH', url({ id }), {}), 400);
    expectRefusal(await call('PATCH', url({ id }), { lines: ['a', 'b'] }), 400);
    // Nothing above changed the comment.
    expect(body<ScmCommentList>(await call('GET', url()))).toEqual(created);
  });

  it('answers a delete of an unknown id with the unchanged list', async () => {
    const dir = await makeRepo();
    const created = body<ScmCommentList>(
      await call('POST', route('/scm/comments', { repo: dir }), comment()),
    );
    const res = await call('DELETE', route('/scm/comments', { repo: dir, id: 'gone' }));
    expect(res.statusCode).toBe(200);
    expect(body<ScmCommentList>(res)).toEqual(created);
  });
});

describe('an unexpected failure', () => {
  it('is a JSON 500 that names no filesystem path, and is logged', async () => {
    const dir = await makeRepo();
    // A directory where the project's comments file belongs: reading it fails with EISDIR.
    const key = createHash('sha256').update(dir).digest('hex').slice(0, 16);
    await mkdir(join(configDir, '.cache', 'scm', `${key}.json`), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const res of [
        await call('GET', route('/scm/comments', { repo: dir })),
        await call('POST', route('/scm/comments', { repo: dir }), comment()),
      ]) {
        expectRefusal(res, 500);
        expect(res.body).not.toContain(configDir);
      }
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain('EISDIR');
    } finally {
      warn.mockRestore();
    }
  });

  // The status poll runs every second while a view is open. It only reports the
  // comments' rev, so a comments file it cannot read must not turn it into a 500 on
  // every poll: it answers without a rev and says why once.
  it('does not turn an unreadable comments file into a failing status poll', async () => {
    const dir = await makeRepo();
    const key = createHash('sha256').update(dir).digest('hex').slice(0, 16);
    await mkdir(join(configDir, '.cache', 'scm', `${key}.json`), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let poll = 0; poll < 3; poll++) {
        const res = await call('GET', route('/scm/status', { repo: dir }));
        expect(res.statusCode, res.body).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({ top: dir, commentsRev: 0 });
        expect(res.body).not.toContain(configDir);
      }
      const unreadable = warn.mock.calls.filter((call) =>
        String(call[0]).includes('cannot read the comments file'),
      );
      expect(unreadable).toHaveLength(1);
      expect(String(unreadable[0]?.[0])).toContain('EISDIR');
    } finally {
      warn.mockRestore();
    }
  });
});

// ── /scm/stage, /scm/unstage, /scm/restore ────────────────────────────────────

describe('POST /scm/stage, /scm/unstage and /scm/restore', () => {
  it('stages the snapshot, refreshes the next status at once, and undoes and redoes it', async () => {
    const dir = await makeRepo();
    const original = await indexListing(dir);
    await put(dir, 'a.txt', 'one\nTWO\nthree\n');
    // Warm the 500 ms status cache: a write has to invalidate it.
    expect((await statusOf(dir)).staged).toEqual([]);

    const staged = await stage(dir, 'a.txt');
    expect(staged.status).toBe('staged');
    expect(staged.receiptId).toBeTypeOf('string');
    expect(await stagedNames(dir)).toEqual(['a.txt']);
    expect((await statusOf(dir)).staged.map((e) => e.path)).toEqual(['a.txt']);
    // The work tree is untouched.
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n');

    const undone = await call('POST', route('/scm/restore', { repo: dir }), {
      receiptId: staged.receiptId,
    });
    expect(undone.statusCode, undone.body).toBe(200);
    const undoneBody = body<ScmWriteResult>(undone);
    expect(undoneBody.status).toBe('restored');
    expect(await indexListing(dir)).toBe(original);
    expect((await statusOf(dir)).staged).toEqual([]);

    // The used receipt is gone; the answer carries a fresh one that redoes the stage.
    expectRefusal(
      await call('POST', route('/scm/restore', { repo: dir }), { receiptId: staged.receiptId }),
      410,
      'token',
    );
    const redone = await call('POST', route('/scm/restore', { repo: dir }), {
      receiptId: undoneBody.receiptId,
    });
    expect(redone.statusCode, redone.body).toBe(200);
    expect(await stagedNames(dir)).toEqual(['a.txt']);
  });

  it('unstages a file back to HEAD', async () => {
    const dir = await makeRepo();
    const original = await indexListing(dir);
    await put(dir, 'a.txt', 'one\nTWO\nthree\n');
    await git(dir, 'add', 'a.txt');
    const res = await call('POST', route('/scm/unstage', { repo: dir }), { path: 'a.txt' });
    expect(res.statusCode, res.body).toBe(200);
    expect(body<ScmWriteResult>(res).status).toBe('unstaged');
    expect(await indexListing(dir)).toBe(original);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('answers 409 busy while another program holds index.lock, waits for nothing, and recovers', async () => {
    const dir = await makeRepo();
    await put(dir, 'a.txt', 'one\nTWO\nthree\n');
    const token = (await snapshotOf(dir, 'a.txt')).token as string;
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, 'someone else');
    const before = await indexListing(dir);

    const started = Date.now();
    expectRefusal(
      await call('POST', route('/scm/stage', { repo: dir }), { path: 'a.txt', token }),
      409,
      'busy',
    );
    expectRefusal(
      await call('POST', route('/scm/unstage', { repo: dir }), { path: 'a.txt' }),
      409,
      'busy',
    );
    expect(Date.now() - started).toBeLessThan(2000);
    // Their lock is theirs: still there, with their content, and the index untouched.
    expect(await readFile(lock, 'utf8')).toBe('someone else');
    expect(await indexListing(dir)).toBe(before);

    await rm(lock);
    const res = await call('POST', route('/scm/stage', { repo: dir }), { path: 'a.txt', token });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stagedNames(dir)).toEqual(['a.txt']);
  });

  it('refuses an unknown, missing, foreign or another file’s token', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n', 'b.txt': 'one\n' });
    const elsewhere = await makeRepo({ 'a.txt': 'one\n' });
    await put(dir, 'a.txt', 'two\n');
    await put(dir, 'b.txt', 'two\n');
    await put(elsewhere, 'a.txt', 'two\n');
    const aToken = (await snapshotOf(dir, 'a.txt')).token as string;
    const url = route('/scm/stage', { repo: dir });

    expectRefusal(await call('POST', url, { path: 'a.txt', token: 'not-a-token' }), 410, 'token');
    expectRefusal(await call('POST', url, { path: 'a.txt' }), 400);
    expectRefusal(await call('POST', url, { path: 'b.txt', token: aToken }), 400);
    expectRefusal(
      await call('POST', route('/scm/stage', { repo: elsewhere }), {
        path: 'a.txt',
        token: aToken,
      }),
      400,
    );
    expect(await stagedNames(dir)).toEqual([]);
    expect(await stagedNames(elsewhere)).toEqual([]);
  });

  it('refuses an escaping, absolute or missing path, and a body that is not an object', async () => {
    const dir = await makeRepo();
    for (const endpoint of ['/scm/stage', '/scm/unstage']) {
      const url = route(endpoint, { repo: dir });
      for (const path of ['../x', '/etc/passwd', 'a\0b', '']) {
        expectRefusal(await call('POST', url, { path, token: 'x' }), 400);
      }
      expectRefusal(await call('POST', url, {}), 400);
      expectRefusal(await call('POST', url, '[]', { 'content-type': 'application/json' }), 400);
      expectRefusal(await call('POST', url, 'text', { 'content-type': 'text/plain' }), 400);
    }
    expectRefusal(
      await call('POST', route('/scm/unstage', { repo: dir }), { path: 'a.txt', oldPath: '../x' }),
      400,
    );
  });

  it('refuses a relative or non-top repo on all three writes', async () => {
    const dir = await makeRepo({ 'src/app.ts': 'x\n' });
    for (const repo of ['work/app', join(dir, 'src')]) {
      for (const [path, payload] of [
        ['/scm/stage', { path: 'src/app.ts', token: 'x' }],
        ['/scm/unstage', { path: 'src/app.ts' }],
        ['/scm/restore', { receiptId: 'x' }],
      ] as const) {
        expectRefusal(await call('POST', route(path, { repo }), payload), 400);
      }
    }
    expectRefusal(await call('POST', '/scm/restore', { receiptId: 'x' }), 400);
  });

  it('refuses an unknown, missing or foreign receipt', async () => {
    const dir = await makeRepo();
    const elsewhere = await makeRepo();
    await put(dir, 'a.txt', 'one\nTWO\nthree\n');
    const { receiptId } = await stage(dir, 'a.txt');
    const url = route('/scm/restore', { repo: dir });
    expectRefusal(await call('POST', url, { receiptId: 'not-a-receipt' }), 410, 'token');
    expectRefusal(await call('POST', url, {}), 400);
    expectRefusal(
      await call('POST', route('/scm/restore', { repo: elsewhere }), { receiptId }),
      400,
    );
    // The refusals above did not spend it.
    expect((await call('POST', url, { receiptId })).statusCode).toBe(200);
  });

  it('answers 409 conflict to an Undo after another writer changed the entry', async () => {
    const dir = await makeRepo();
    await put(dir, 'a.txt', 'one\nTWO\nthree\n');
    const { receiptId } = await stage(dir, 'a.txt');
    await put(dir, 'a.txt', 'one\nTWO\nthree\nfour\n');
    await git(dir, 'add', 'a.txt'); // someone else restaged it
    expectRefusal(
      await call('POST', route('/scm/restore', { repo: dir }), { receiptId }),
      409,
      'conflict',
    );
    expect(await stagedNames(dir)).toEqual(['a.txt']);
  });
});
