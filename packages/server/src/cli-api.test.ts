import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { CliResultEntry, ScmCommentInput, ServerMessage } from '@palmux/shared';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { createComment } from './scm-comments';
import { scmCacheStats } from './scm-snapshot';
import { createServer, createSessionRegistry, type SessionRegistry } from './server';
import { ttyOf } from './session-restore';
import { memoryTabsStore } from './tabs-store';

let app: FastifyInstance;
let registry: SessionRegistry;
let port: number;
let prevConfigDir: string | undefined;
let files: string;
// How long the server waits for a window in these tests; the default is 3 s.
const ANSWER_MS = 400;
const EDIT_LIMIT = 4096;
// How long one `wait` request holds before it answers that the files are still open.
const WAIT_MS = 300;
// Read once, as the shell starts: zsh's startup points fd 0 at a pipe for a while, so a later
// `ttyOf` can read null. The registry keeps the tty it captured at spawn for the same reason.
let shellTty: string | null = null;

beforeAll(async () => {
  prevConfigDir = process.env['PALMUX_CONFIG_DIR'];
  process.env['PALMUX_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'palmux-cli-'));
  files = mkdtempSync(join(tmpdir(), 'palmux-cli-files-'));
  writeFileSync(join(files, 'a.mp4'), 'a');
  writeFileSync(join(files, 'b.mp4'), 'b');
  const cfg: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    fontDirs: [],
    auth: false,
    maxUploadBytes: EDIT_LIMIT,
  };
  // In-memory stores: the defaults point at the real config dir and sweep its tty hints.
  registry = createSessionRegistry(cfg, memoryTabsStore());
  app = await createServer(cfg, 'a'.repeat(64), registry, {
    cliAnswerMs: ANSWER_MS,
    cliWaitMs: WAIT_MS,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const id of registry.ids()) registry.kill(id);
  await app.close();
  if (prevConfigDir === undefined) delete process.env['PALMUX_CONFIG_DIR'];
  else process.env['PALMUX_CONFIG_DIR'] = prevConfigDir;
});

/** Attach a data socket to terminal `id`, collecting its text frames, once `ready` arrives. */
function attach(id: string): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${id}`);
    const messages: ServerMessage[] = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as ServerMessage;
      messages.push(msg);
      if (msg.type === 'ready') resolve({ ws, messages });
    });
  });
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/cli', payload: body as object, headers });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('POST /cli download', () => {
  it('sends the paths that resolve to the socket attached to the caller tty, and lists the rest', async () => {
    const { ws, messages } = await attach('0');
    shellTty = ttyOf(registry.get('0').pid);
    const tty = shellTty;
    expect(tty).toMatch(/^pts\//);
    const missing = join(files, 'nope.mp4');
    const res = await post({
      cmd: 'download',
      tty,
      paths: [join(files, 'a.mp4'), missing, join(files, '*.mp4')],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sent: [join(files, 'a.mp4'), join(files, '*.mp4')],
      failed: [{ path: missing, error: 'not found' }],
    });
    await until(() => messages.some((m) => m.type === 'download'));
    expect(messages.find((m) => m.type === 'download')).toEqual({
      type: 'download',
      paths: [join(files, 'a.mp4'), join(files, '*.mp4')],
    });
    ws.close();
  });

  it('sends nothing when no path resolves', async () => {
    const { ws, messages } = await attach('0');
    const tty = shellTty;
    const res = await post({ cmd: 'download', tty, paths: ['relative.mp4'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.some((m) => m.type === 'download')).toBe(false);
    ws.close();
  });

  it('answers 409 for a tty no attached palmux terminal is on', async () => {
    const res = await post({ cmd: 'download', tty: 'pts/99999', paths: [join(files, 'a.mp4')] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/palmux terminal/);
  });

  it('answers 409 once the terminal has no socket attached', async () => {
    const { ws } = await attach('0');
    const tty = shellTty;
    ws.close();
    await until(() => ws.readyState === ws.CLOSED);
    await new Promise((r) => setTimeout(r, 50));
    const res = await post({ cmd: 'download', tty, paths: [join(files, 'a.mp4')] });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a request that carries an Origin (a browser page, not the CLI)', async () => {
    const res = await post(
      { cmd: 'download', tty: 'pts/1', paths: ['/x'] },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
  });

  it('answers 400 for a malformed body', async () => {
    expect((await post({ cmd: 'download', paths: ['/x'] })).statusCode).toBe(400);
    expect((await post({ cmd: 'download', tty: 'pts/1', paths: [] })).statusCode).toBe(400);
    expect((await post({ cmd: 'nope', tty: 'pts/1', paths: ['/x'] })).statusCode).toBe(400);
  });
});

const postJson = async (body: unknown) => {
  const res = await post(body);
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
};

describe('POST /cli requests', () => {
  it('answers 400 for a request that names no command, an unknown one, or lacks a field', async () => {
    const { ws, messages } = await attach('0');
    const tty = shellTty;
    const bad: unknown[] = [
      {},
      { tty },
      { cmd: 'frobnicate', tty, paths: ['/x'] },
      { cmd: 'open', tty },
      { cmd: 'open', tty, paths: [] },
      { cmd: 'open', paths: ['/x'] },
      { cmd: 'open', tty, paths: [1] },
      { cmd: 'git', tty },
      { cmd: 'git', cwd: '/tmp' },
      { cmd: 'comments' },
      { cmd: 'comments', cwd: 5 },
    ];
    for (const body of bad) {
      const res = await postJson(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body['error']).toEqual(expect.any(String));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(
      messages.some((m) => m.type === 'cliOpen' || m.type === 'cliGit' || m.type === 'download'),
    ).toBe(false);
    ws.close();
  });

  it('lists the supported commands in every kind of reply', async () => {
    const commands = ['download', 'open', 'git', 'comments', 'web', 'status', 'wait'];
    const ok = await postJson({ cmd: 'download', tty: 'pts/99999', paths: ['/x'] });
    expect(ok.status).toBe(409);
    expect(ok.body['commands']).toEqual(commands);
    expect((await postJson({})).body['commands']).toEqual(commands);
    const refused = await post(
      { cmd: 'open', tty: 'pts/1', paths: ['/x'] },
      { origin: 'https://x.example' },
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().commands).toEqual(commands);
    const empty = await postJson({ cmd: 'download', tty: shellTty, paths: ['relative.mp4'] });
    expect(empty.status).toBe(200);
    expect(empty.body['commands']).toEqual(commands);
  });

  it('answers a body that is not JSON in the same shape, refuses it with an Origin, and logs each once', async () => {
    const commands = ['download', 'open', 'git', 'comments', 'web', 'status', 'wait'];
    const raw = (payload: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/cli',
        payload,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // Malformed, then empty: Fastify rejects both before a route handler runs.
      const malformed = await raw('{"cmd": "open", "tty');
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: 'the request body is not JSON', commands });
      const empty = await raw('');
      expect(empty.statusCode).toBe(400);
      expect(empty.json()).toEqual({ error: 'the request body is not JSON', commands });
      const form = await raw('<cmd>open</cmd>', { 'content-type': 'application/xml' });
      expect(form.statusCode).toBe(415);
      expect(form.json()).toEqual({ error: 'the request body is not JSON', commands });
      const browser = await raw('{bad', { origin: 'https://evil.example' });
      expect(browser.statusCode).toBe(403);
      expect(browser.json()).toEqual({
        error: 'the CLI endpoint does not take browser requests',
        commands,
      });
      const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(': cli '));
      expect(lines).toEqual([
        'palmux: cli - tty=- -> 400 the request body is not JSON',
        'palmux: cli - tty=- -> 400 the request body is not JSON',
        'palmux: cli - tty=- -> 415 the request body is not JSON',
        'palmux: cli - tty=- -> 403 the CLI endpoint does not take browser requests',
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it('answers a body over the limit in the same shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cli',
      payload: JSON.stringify({ cmd: 'open', tty: 'pts/1', paths: ['/x'.repeat(600_000)] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: 'the request body is too large',
      commands: ['download', 'open', 'git', 'comments', 'web', 'status', 'wait'],
    });
  });
});

/** Wait for a frame of `type` on a socket's message list, then return it. */
async function frame<T extends ServerMessage['type']>(
  messages: ServerMessage[],
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  await until(() => messages.some((m) => m.type === type));
  const found = messages.find((m) => m.type === type);
  if (!found) throw new Error(`no ${type} frame arrived`);
  return found as Extract<ServerMessage, { type: T }>;
}

const answer = (ws: WebSocket, requestId: string, results: CliResultEntry[], note?: string) =>
  ws.send(
    JSON.stringify({
      type: 'cliResult',
      requestId,
      results,
      ...(note !== undefined ? { note } : {}),
    }),
  );

describe('POST /cli open', () => {
  const textFile = (name: string, size = 3) => {
    const path = join(files, name);
    writeFileSync(path, 'x'.repeat(size));
    return path;
  };

  it('sends the file to the window, returns what it opened, and logs one line', async () => {
    const { ws, messages } = await attach('0');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const file = textFile('open-one.txt');
      const started = Date.now();
      const pending = post({ cmd: 'open', tty: shellTty, paths: [file] });
      const sent = await frame(messages, 'cliOpen');
      expect(sent.paths).toEqual([file]);
      answer(ws, sent.requestId, [{ path: file, ok: true }]);
      const res = await pending;
      // Answered by the window, not by the timer.
      expect(Date.now() - started).toBeLessThan(ANSWER_MS);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ opened: [file], failed: [] });
      const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('cli open'));
      expect(lines).toEqual([`palmux: cli open tty=${shellTty} -> 200 opened=1 failed=0`]);
    } finally {
      info.mockRestore();
      ws.close();
    }
  });

  it('sends each path in its canonical form, so a second spelling finds the open tab', async () => {
    const { ws, messages } = await attach('0');
    try {
      const file = textFile('open-dot.txt');
      const pending = post({
        cmd: 'open',
        tty: shellTty,
        paths: [`${files}/./sub/..//open-dot.txt`],
      });
      const sent = await frame(messages, 'cliOpen');
      expect(sent.paths).toEqual([file]);
      answer(ws, sent.requestId, [{ path: file, ok: true }]);
      expect((await pending).json()).toMatchObject({ opened: [file], failed: [] });
    } finally {
      ws.close();
    }
  });

  it('opens file:line[:col] at that position when only the file without the suffix exists', async () => {
    const { ws, messages } = await attach('0');
    try {
      const file = textFile('open-goto.ts');
      const pending = postJson({
        cmd: 'open',
        tty: shellTty,
        paths: [`${file}:42:7`, `${file}:3`],
      });
      const sent = await frame(messages, 'cliOpen');
      expect(sent.paths).toEqual([file, file]);
      expect(sent.goto).toEqual([
        { path: file, line: 42, column: 7 },
        { path: file, line: 3 },
      ]);
      answer(ws, sent.requestId, [{ path: file, ok: true }]);
      const res = await pending;
      expect(res.body).toMatchObject({ opened: [file, file], failed: [] });
    } finally {
      ws.close();
    }
  });

  it('opens a file whose own name ends in :N as itself, and reports a missing file:line as typed', async () => {
    const { ws, messages } = await attach('0');
    try {
      const literal = textFile('notes:12');
      const missing = join(files, 'gone.ts:4');
      const pending = postJson({ cmd: 'open', tty: shellTty, paths: [literal, missing] });
      const sent = await frame(messages, 'cliOpen');
      expect(sent.paths).toEqual([literal]);
      expect(sent.goto).toBeUndefined();
      answer(ws, sent.requestId, [{ path: literal, ok: true }]);
      expect((await pending).body).toMatchObject({
        opened: [literal],
        failed: [{ path: missing, error: 'not found' }],
      });
    } finally {
      ws.close();
    }
  });

  it('refuses a directory, a missing file, a relative path and an oversize file without a frame', async () => {
    const { ws, messages } = await attach('0');
    const big = textFile('open-big.txt', EDIT_LIMIT + 1);
    const paths = [files, join(files, 'nope.txt'), 'relative.txt', big];
    const res = await postJson({ cmd: 'open', tty: shellTty, paths });
    expect(res.status).toBe(200);
    expect(res.body['opened']).toEqual([]);
    expect(res.body['failed']).toEqual([
      { path: files, error: 'path is a directory' },
      { path: join(files, 'nope.txt'), error: 'not found' },
      { path: 'relative.txt', error: 'path must be absolute' },
      { path: big, error: `file is ${EDIT_LIMIT + 1} bytes; the editor limit is ${EDIT_LIMIT}` },
    ]);
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.some((m) => m.type === 'cliOpen')).toBe(false);
    ws.close();
  });

  it('keeps argument order across opened and failed, and reports window refusals and silences', async () => {
    const { ws, messages } = await attach('0');
    const a = textFile('open-a.txt');
    const b = textFile('open-b.txt');
    const c = textFile('open-c.txt');
    const missing = join(files, 'nope.txt');
    const pending = postJson({ cmd: 'open', tty: shellTty, paths: [a, missing, b, files, c] });
    const sent = await frame(messages, 'cliOpen');
    expect(sent.paths).toEqual([a, b, c]);
    // c is never reported.
    answer(ws, sent.requestId, [
      { path: b, ok: false, error: 'open in another window' },
      { path: a, ok: true },
    ]);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body['opened']).toEqual([a]);
    expect(res.body['failed']).toEqual([
      { path: missing, error: 'not found' },
      { path: b, error: 'open in another window' },
      { path: files, error: 'path is a directory' },
      { path: c, error: 'the window did not report this path' },
    ]);
    ws.close();
  });

  it('answers 504 when no window answers in time, and ignores a late answer', async () => {
    const { ws, messages } = await attach('0');
    const file = textFile('open-late.txt');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const res = await postJson({ cmd: 'open', tty: shellTty, paths: [file] });
      expect(res.status).toBe(504);
      expect(res.body['error']).toBe('no palmux window answered within 3 s');
      expect(res.body['commands']).toBeDefined();
      const sent = await frame(messages, 'cliOpen');
      answer(ws, sent.requestId, [{ path: file, ok: true }]);
      await new Promise((r) => setTimeout(r, 50));
      expect(info.mock.calls.map((c) => String(c[0]))).toContain(
        `palmux: cli open tty=${shellTty} -> 504 no answer`,
      );
    } finally {
      info.mockRestore();
      ws.close();
    }
  });

  it('ignores an answer that comes on another socket', async () => {
    const { ws, messages } = await attach('0');
    const other = await attach('1');
    const file = textFile('open-foreign.txt');
    const pending = postJson({ cmd: 'open', tty: shellTty, paths: [file] });
    const sent = await frame(messages, 'cliOpen');
    answer(other.ws, sent.requestId, [{ path: file, ok: false, error: 'from the wrong window' }]);
    answer(other.ws, 'not-a-pending-request', [{ path: file, ok: false, error: 'unknown' }]);
    await new Promise((r) => setTimeout(r, 80));
    answer(ws, sent.requestId, [{ path: file, ok: true }]);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body['opened']).toEqual([file]);
    ws.close();
    other.ws.close();
  });

  it('answers 409 for a tty no terminal is on', async () => {
    const res = await postJson({ cmd: 'open', tty: 'pts/99999', paths: [join(files, 'a.mp4')] });
    expect(res.status).toBe(409);
  });
});

function makeRepo(): { top: string; nested: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'palmux-cli-repo-')));
  execFileSync('git', ['init', '-q', dir]);
  const nested = join(dir, 'lib', 'deep');
  mkdirSync(nested, { recursive: true });
  return { top: dir, nested };
}

describe('POST /cli git', () => {
  it('sends the work tree top for a nested folder and returns the window note', async () => {
    const { ws, messages } = await attach('0');
    const { top, nested } = makeRepo();
    const pending = postJson({ cmd: 'git', tty: shellTty, cwd: nested });
    const sent = await frame(messages, 'cliGit');
    expect(sent.repo).toBe(top);
    answer(
      ws,
      sent.requestId,
      [{ path: top, ok: true }],
      'this window has no Source Control panel',
    );
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ repo: top, note: 'this window has no Source Control panel' });
    ws.close();
  });

  it('answers without a note when the window sends none', async () => {
    const { ws, messages } = await attach('0');
    const { top } = makeRepo();
    const pending = postJson({ cmd: 'git', tty: shellTty, cwd: top });
    const sent = await frame(messages, 'cliGit');
    answer(ws, sent.requestId, [{ path: top, ok: true }]);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body['repo']).toBe(top);
    expect('note' in res.body).toBe(false);
    ws.close();
  });

  it('answers 400 outside a repository, with no frame', async () => {
    const { ws, messages } = await attach('0');
    const res = await postJson({ cmd: 'git', tty: shellTty, cwd: files });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/git/);
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.some((m) => m.type === 'cliGit')).toBe(false);
    ws.close();
  });

  it('answers 400 with the window error when it refuses, and 504 when it is silent', async () => {
    const { ws, messages } = await attach('0');
    const { top } = makeRepo();
    const refused = postJson({ cmd: 'git', tty: shellTty, cwd: top });
    const sent = await frame(messages, 'cliGit');
    answer(ws, sent.requestId, [{ path: top, ok: false, error: 'no panel' }]);
    expect(await refused).toMatchObject({ status: 400, body: { error: 'no panel' } });
    const silent = await postJson({ cmd: 'git', tty: shellTty, cwd: top });
    expect(silent.status).toBe(504);
    ws.close();
  });

  it('answers 409 for a tty no terminal is on', async () => {
    const { top } = makeRepo();
    expect((await postJson({ cmd: 'git', tty: 'pts/99999', cwd: top })).status).toBe(409);
  });
});

const comment = (over: Partial<ScmCommentInput>): ScmCommentInput => ({
  path: 'src/a.ts',
  version: 'worktree',
  side: 'new',
  start: 1,
  end: 2,
  lines: ['const a = 1;', 'const b = 2;'],
  before: [],
  after: [],
  body: 'rename this',
  ...over,
});

describe('POST /cli comments', () => {
  it('prints the document for three comments in two files, with no terminal and no token kept', async () => {
    const { top } = makeRepo();
    mkdirSync(join(top, 'src'));
    writeFileSync(join(top, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\n');
    await createComment(top, comment({ body: 'first' }));
    await createComment(top, comment({ start: 2, lines: ['const b = 2;'], body: 'second' }));
    await createComment(
      top,
      comment({ path: 'src/b.ts', start: 1, end: 1, lines: ['x'], body: 'third' }),
    );
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const before = scmCacheStats().entries;
    try {
      const res = await postJson({ cmd: 'comments', cwd: join(top, 'src') });
      expect(res.status).toBe(200);
      const markdown = res.body['markdown'] as string;
      expect(markdown.startsWith('# Review comments')).toBe(true);
      expect(markdown).toContain(`in ${top}.`);
      expect(markdown.match(/^## /gm)).toHaveLength(2);
      expect(markdown.match(/^### /gm)).toHaveLength(3);
      expect(markdown).toContain('### src/a.ts:L1-L2 (new)\n');
      expect(markdown).toContain('third');
      expect(scmCacheStats().entries).toBe(before);
      expect(info.mock.calls.map((c) => String(c[0]))).toContain(
        'palmux: cli comments tty=- -> 200 comments=3',
      );
    } finally {
      info.mockRestore();
    }
  });

  it('answers an empty string when the repository has no comments', async () => {
    const { top } = makeRepo();
    const res = await postJson({ cmd: 'comments', cwd: top });
    expect(res.status).toBe(200);
    expect(res.body['markdown']).toBe('');
  });

  it('answers 400 outside a repository', async () => {
    const res = await postJson({ cmd: 'comments', cwd: files });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/git/);
  });
});

describe('POST /cli web', () => {
  it('sends a port as a localhost url, a host with no scheme as http, and answers the url', async () => {
    const cases: [string, string][] = [
      ['5173', 'http://localhost:5173/'],
      ['localhost:8080/docs', 'http://localhost:8080/docs'],
      ['https://example.com/a?b=1', 'https://example.com/a?b=1'],
    ];
    for (const [target, url] of cases) {
      const { ws, messages } = await attach('0');
      const pending = postJson({ cmd: 'web', tty: shellTty, url: target });
      const sent = await frame(messages, 'cliWeb');
      expect(sent.url).toBe(url);
      answer(ws, sent.requestId, [{ path: url, ok: true }]);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body['url']).toBe(url);
      ws.close();
    }
  });

  it('refuses a scheme a web tab cannot show, and a port out of range, without a frame', async () => {
    const { ws, messages } = await attach('0');
    for (const target of ['ftp://example.com', 'javascript:alert(1)', '70000', '0']) {
      const res = await postJson({ cmd: 'web', tty: shellTty, url: target });
      expect(res.status).toBe(400);
      expect(res.body['error']).toMatch(/http/);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.some((m) => m.type === 'cliWeb')).toBe(false);
    ws.close();
  });

  it('answers 400 with the window error when it refuses, and 504 when it is silent', async () => {
    const { ws, messages } = await attach('0');
    const pending = postJson({ cmd: 'web', tty: shellTty, url: '3000' });
    const sent = await frame(messages, 'cliWeb');
    answer(ws, sent.requestId, [{ path: sent.url, ok: false, error: 'open in another window' }]);
    expect(await pending).toMatchObject({ status: 400, body: { error: 'open in another window' } });
    messages.length = 0;
    const silent = await postJson({ cmd: 'web', tty: shellTty, url: '3000' });
    expect(silent.status).toBe(504);
    ws.close();
  });
});

describe('POST /cli status', () => {
  it('answers the server version, and the terminal on the tty with its window and attachment', async () => {
    const bare = await postJson({ cmd: 'status' });
    expect(bare.status).toBe(200);
    expect(bare.body['version']).toEqual(expect.any(String));
    expect(bare.body).not.toHaveProperty('terminal');

    const unknown = await postJson({ cmd: 'status', tty: 'pts/99999' });
    expect(unknown.body['terminal']).toBeNull();

    const { ws } = await attach('0');
    const here = await postJson({ cmd: 'status', tty: shellTty });
    expect(here.body['terminal']).toEqual({ id: '0', window: null, attached: true });
    ws.close();
    await until(() => app.terminalSocket('0') === undefined);
    const gone = await postJson({ cmd: 'status', tty: shellTty });
    expect(gone.body['terminal']).toEqual({ id: '0', window: null, attached: false });
  });
});

describe('POST /cli wait', () => {
  const editorOn = (name: string) => {
    const path = join(files, name);
    writeFileSync(path, 'x');
    return path;
  };

  it('answers as soon as every file has no editor tab, and lists what is still open after the window', async () => {
    const a = editorOn('wait-a.txt');
    const b = editorOn('wait-b.txt');
    const ta = registry.createTab({ kind: 'editor', url: a })!;
    const tb = registry.createTab({ kind: 'editor', url: b })!;
    const held = await postJson({ cmd: 'wait', paths: [a, b] });
    expect(held).toMatchObject({ status: 200, body: { open: [a, b] } });

    const started = Date.now();
    const pending = postJson({ cmd: 'wait', paths: [a, b] });
    setTimeout(() => registry.kill(ta), 50);
    setTimeout(() => registry.kill(tb), 100);
    expect((await pending).body['open']).toEqual([]);
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
  });

  it('with appear, waits for a tab that is still being created before it counts as closed', async () => {
    const c = editorOn('wait-c.txt');
    const pending = postJson({ cmd: 'wait', paths: [c], appear: true });
    let id = '';
    setTimeout(() => {
      id = registry.createTab({ kind: 'editor', url: c })!;
    }, 50);
    expect((await pending).body['open']).toEqual([c]);
    registry.kill(id);
    const never = await postJson({
      cmd: 'wait',
      paths: [editorOn('wait-never.txt')],
      appear: true,
    });
    expect(never.body['open']).toEqual([]);
  });

  it('refuses a request with no absolute paths', async () => {
    for (const paths of [[], ['relative.txt'], 'x']) {
      expect((await postJson({ cmd: 'wait', paths })).status).toBe(400);
    }
  });
});
