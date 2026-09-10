import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import { createServer, createSessionRegistry, type SessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';

const secret = 'a'.repeat(64);

// The routes resolve notes/artifacts under configDir() — isolate it per run.
let configDir: string;
let prevConfigDir: string | undefined;
let app: FastifyInstance;
let registry: SessionRegistry;

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'palmux-panes-'));
  prevConfigDir = process.env['PALMUX_CONFIG_DIR'];
  process.env['PALMUX_CONFIG_DIR'] = configDir;
  const cfg: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    fontDirs: [],
    auth: false,
    maxUploadBytes: 1024,
  };
  registry = createSessionRegistry(cfg, memoryTabsStore());
  app = await createServer(cfg, secret, registry);
});

afterAll(async () => {
  if (prevConfigDir === undefined) delete process.env['PALMUX_CONFIG_DIR'];
  else process.env['PALMUX_CONFIG_DIR'] = prevConfigDir;
  await app.close();
});

describe('GET/PUT /pane-file', () => {
  it('404s an unknown tab and a non-editor tab', async () => {
    registry.createTab({ kind: 'web', url: 'https://a' }); // id 0
    expect((await app.inject({ method: 'GET', url: '/pane-file?tab=9' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/pane-file?tab=0' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'PUT', url: '/pane-file?tab=0', payload: 'x' })).statusCode,
    ).toBe(404);
  });

  it('round-trips editor content; a never-written note reads as empty', async () => {
    const id = registry.createTab({ kind: 'editor' })!;
    const empty = await app.inject({ method: 'GET', url: `/pane-file?tab=${id}` });
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toBe('');

    const put = await app.inject({
      method: 'PUT',
      url: `/pane-file?tab=${id}`,
      headers: { 'content-type': 'text/plain' },
      payload: '# scratch\nhello',
    });
    expect(put.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: `/pane-file?tab=${id}` });
    expect(got.body).toBe('# scratch\nhello');
    expect(got.headers['content-type']).toContain('text/plain');
  });

  it('413s a body over maxUploadBytes and keeps the previous content', async () => {
    const id = registry.createTab({ kind: 'editor' })!;
    await app.inject({
      method: 'PUT',
      url: `/pane-file?tab=${id}`,
      headers: { 'content-type': 'text/plain' },
      payload: 'keep me',
    });
    const big = await app.inject({
      method: 'PUT',
      url: `/pane-file?tab=${id}`,
      headers: { 'content-type': 'text/plain' },
      payload: Buffer.alloc(2048), // cap is 1024
    });
    expect(big.statusCode).toBe(413);
    const got = await app.inject({ method: 'GET', url: `/pane-file?tab=${id}` });
    expect(got.body).toBe('keep me');
  });
});

describe('GET /artifacts/<name>', () => {
  it('serves files from the artifacts dir', async () => {
    writeFileSync(join(configDir, 'artifacts', 'report.html'), '<h1>hi</h1>');
    const res = await app.inject({ method: 'GET', url: '/artifacts/report.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>hi</h1>');
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('404s a missing artifact instead of falling back to the SPA shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/artifacts/nope.html' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root">');
  });

  it('rejects path traversal over a raw socket (inject normalizes .. away)', async () => {
    // Browsers and inject() normalize dot segments client-side, so the only
    // way to actually exercise the traversal guard is a raw HTTP request.
    writeFileSync(join(configDir, 'outside.txt'), 'secret');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const rawGet = (path: string) =>
      new Promise<string>((resolve) => {
        const sock = connect(port, '127.0.0.1', () => {
          sock.write(`GET ${path} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`);
        });
        let buf = '';
        sock.on('data', (d) => (buf += String(d)));
        sock.on('close', () => resolve(buf));
      });
    for (const path of [
      '/artifacts/../outside.txt',
      '/artifacts/..%2Foutside.txt',
      '/artifacts/%2e%2e/outside.txt',
      '/artifacts/%2e%2e%2foutside.txt',
    ]) {
      const res = await rawGet(path);
      expect(res.startsWith('HTTP/1.1 404')).toBe(true);
      expect(res).not.toContain('secret');
    }
  });
});

describe('auth gating for pane routes', () => {
  let authed: FastifyInstance;

  beforeAll(async () => {
    const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: true };
    authed = await createServer(cfg, secret, createSessionRegistry(cfg, memoryTabsStore()));
  });
  afterAll(async () => {
    await authed.close();
  });

  it('401s /pane-file and /artifacts without the cookie', async () => {
    expect((await authed.inject({ method: 'GET', url: '/pane-file?tab=0' })).statusCode).toBe(401);
    expect((await authed.inject({ method: 'GET', url: '/artifacts/report.html' })).statusCode).toBe(
      401,
    );
  });

  it('passes the gate with a valid cookie', async () => {
    const res = await authed.inject({
      method: 'GET',
      url: '/artifacts/definitely-missing.html',
      cookies: { [SESSION_COOKIE]: secret },
    });
    expect(res.statusCode).toBe(404); // through the gate, then a real 404
  });
});
