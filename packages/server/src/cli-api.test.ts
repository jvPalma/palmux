// POST /cli — the `palmux` command's server surface. Two layers, because they
// answer different questions: the route's own rules (below, on a bare instance
// with stub deps) and whether it is actually REACHABLE (the integration block,
// which is the one place the registration ordering in `createServer` is pinned —
// the route needs the socket layer, and the socket layer does not exist until
// after the other routes are registered).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import { registerCliRoutes } from './cli-api';
import { createServer, createSessionRegistry } from './server';
import { createHintStore, memoryRestoreStore } from './session-restore';
import { memoryGroupsStore, memoryTabsStore } from './tabs-store';

const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: true, port: 44040 };
const secret = 'a'.repeat(64);

/**
 * A registry with every store in memory or under the temp dir.
 *
 * The defaults point at the REAL `<configDir>/`, and the registry sweeps tty
 * hints at construction — so a test that took the defaults would delete the
 * restore hints of the palmux running on this machine, leaving its terminals to
 * come back from the /proc capture instead (which cannot see a tmux
 * `switch-client`).
 */
const testRegistry = () =>
  createSessionRegistry(
    cfg,
    memoryTabsStore(),
    memoryGroupsStore(),
    undefined,
    memoryRestoreStore(),
    createHintStore(join(dir, 'by-tty')),
  );

/** One file on disk to open, plus a directory that must be refused. */
let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'palmux-cli-'));
  file = join(dir, 'a.txt');
  writeFileSync(file, 'hello\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('POST /cli', () => {
  let app: FastifyInstance;
  let registry: ReturnType<typeof createSessionRegistry>;
  const focused: Array<{ id: string; from?: string }> = [];

  beforeAll(async () => {
    registry = testRegistry();
    app = Fastify();
    registerCliRoutes(app, {
      registry,
      cfg,
      focusTab: (id: string, from?: string) => {
        focused.push(from === undefined ? { id } : { id, from });
      },
      windowCount: () => 3,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/cli', payload, headers });

  it('opens a path as an editor tab and asks a window to show it', async () => {
    focused.length = 0;
    const res = await post({ cmd: 'open', path: file, from: '2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '0', created: true });
    expect(registry.tabs()).toEqual([{ id: '0', kind: 'editor', url: file }]);
    expect(focused).toEqual([{ id: '0', from: '2' }]);
  });

  it('re-uses the existing tab for the same path instead of opening a second', async () => {
    focused.length = 0;
    const res = await post({ cmd: 'open', path: file });
    expect(res.json()).toEqual({ id: '0', created: false });
    expect(registry.tabs()).toHaveLength(1);
    // No origin: the server picks the window, so `from` is absent, not undefined
    // by accident — sending the string "undefined" would match no window at all.
    expect(focused).toEqual([{ id: '0' }]);
  });

  it('ignores an origin that is not a tab id', async () => {
    focused.length = 0;
    await post({ cmd: 'open', path: file, from: 'not-a-tab' });
    expect(focused).toEqual([{ id: '0' }]);
  });

  it('refuses a relative path rather than resolving it against the server cwd', async () => {
    const res = await post({ cmd: 'open', path: 'notes.txt' });
    expect(res.statusCode).toBe(400);
    expect(res.json()['error']).toContain('not an absolute path');
  });

  it('refuses a path that does not exist', async () => {
    const res = await post({ cmd: 'open', path: join(dir, 'nope.txt') });
    expect(res.statusCode).toBe(400);
    expect(res.json()['error']).toContain('no such file');
  });

  // A directory that opened would render an editor over a path that can never be
  // read, so the message names the actual problem instead of "no such file".
  it('refuses a directory', async () => {
    const res = await post({ cmd: 'open', path: dir });
    expect(res.statusCode).toBe(400);
    expect(res.json()['error']).toContain('is a directory');
  });

  it('answers tabs, settings and status', async () => {
    const tabs = await post({ cmd: 'tabs' });
    expect(tabs.json()['tabs']).toEqual([{ id: '0', kind: 'editor', url: file }]);
    expect(Array.isArray(tabs.json()['groups'])).toBe(true);

    const settings = await post({ cmd: 'settings' });
    expect(settings.statusCode).toBe(200);
    expect(typeof settings.json()).toBe('object');

    const status = await post({ cmd: 'status' });
    expect(status.json()['port']).toBe(44040);
    expect(status.json()['tabs']).toBe(1);
    expect(status.json()['windows']).toBe(3);
  });

  // Every command the CLI can emit, and the reply each one owes it. Mirrors the
  // `CliCommand` union in `packages/cli/src/args.ts` — two lists that must agree,
  // and nothing in the type system makes them. `groups` fell into the default
  // branch and answered 400 for the whole first release because this test did not
  // exist; keeping it here is cheaper than the shared constant that would make
  // the drift impossible.
  it('answers every command the CLI can send', async () => {
    const replies = await Promise.all(
      ['open', 'tabs', 'groups', 'settings', 'status'].map(async (cmd) => ({
        cmd,
        res: await post(cmd === 'open' ? { cmd, path: file } : { cmd }),
      })),
    );
    for (const { cmd, res } of replies) {
      expect(`${cmd}: ${res.statusCode}`).toBe(`${cmd}: 200`);
    }
  });

  it('rejects an unknown command with a message naming it', async () => {
    const res = await post({ cmd: 'explode' });
    expect(res.statusCode).toBe(400);
    expect(res.json()['error']).toBe('unknown command: explode');
  });

  // The one guard that does not depend on the cookie being configured: with
  // PALMUX_NO_AUTH=1 the gate is off, and a page on this machine could otherwise
  // drive the registry from a script tag. A browser cannot omit Origin.
  it('rejects any request carrying an Origin', async () => {
    const res = await post({ cmd: 'tabs' }, { origin: 'http://evil.test' });
    expect(res.statusCode).toBe(403);
    expect(registry.tabs()).toHaveLength(1);
  });
});

describe('POST /cli is wired into the real server', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createServer(cfg, secret, testRegistry());
  });
  afterAll(async () => {
    await app.close();
  });

  // No exemption from the cookie gate: the CLI authenticates by reading the same
  // secret, so this route adds no trust model of its own.
  it('is behind the session cookie like every other route', async () => {
    const anon = await app.inject({ method: 'POST', url: '/cli', payload: { cmd: 'status' } });
    expect(anon.statusCode).toBe(401);

    const authed = await app.inject({
      method: 'POST',
      url: '/cli',
      payload: { cmd: 'status' },
      cookies: { [SESSION_COOKIE]: secret },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()['tabs']).toBe(0);
  });
});
