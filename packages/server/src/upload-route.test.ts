import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import { createServer, createSessionRegistry, type SessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';

const baseCfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [] };
const secret = 'a'.repeat(64);

describe('POST /upload (auth enabled)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const cfg = { ...baseCfg, auth: true };
    app = await createServer(cfg, secret, createSessionRegistry(cfg, memoryTabsStore()));
  });
  afterAll(async () => {
    await app.close();
  });

  it('rejects a request without the session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload?session=0',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with a wrong cookie value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload?session=0',
      headers: { 'content-type': 'application/octet-stream' },
      cookies: { [SESSION_COOKIE]: 'b'.repeat(64) },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /upload (no auth)', () => {
  let app: FastifyInstance;
  let registry: SessionRegistry;
  const written: string[] = [];

  beforeAll(async () => {
    const cfg = { ...baseCfg, auth: false, maxUploadBytes: 1024 };
    registry = createSessionRegistry(cfg, memoryTabsStore());
    app = await createServer(cfg, secret, registry);
    registry.get('7'); // spawn a live session the route can validate against
  });
  afterEach(async () => {
    await Promise.all(written.splice(0).map((p) => unlink(p).catch(() => {})));
  });
  afterAll(async () => {
    registry.kill('7');
    await app.close();
  });

  it('404s an unknown session id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload?session=99',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s an empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload?session=7',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
  });

  it('saves any file type and returns its temp path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload?session=7&filename=notes.md',
      headers: { 'content-type': 'text/markdown' },
      payload: Buffer.from('# hello'),
    });
    expect(res.statusCode).toBe(200);
    const { path } = res.json() as { path: string };
    written.push(path);
    expect(path.endsWith('-notes.md')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('# hello');
  });

  it('413s a body over the configured cap (declared length)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload?session=7',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2048), // cap is 1024
    });
    expect(res.statusCode).toBe(413);
  });

  it('coerces a duplicated filename query without throwing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload?session=7&filename=a&filename=b',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(200);
    written.push((res.json() as { path: string }).path);
  });
});

describe('POST /upload — any content type', () => {
  // `'*'` is a FALLBACK, not a catch-all: Fastify's own application/json and
  // text/plain parsers win over it, so the body arrived as an object/string and
  // the route — which wants a Buffer — answered "empty body". Every .json and
  // .txt upload failed while the same bytes labelled octet-stream saved fine.
  let app: FastifyInstance;
  let registry: SessionRegistry;
  const written: string[] = [];

  beforeAll(async () => {
    const cfg = { ...baseCfg, auth: false };
    registry = createSessionRegistry(cfg, memoryTabsStore());
    app = await createServer(cfg, secret, registry);
    registry.get('7');
  });
  afterEach(async () => {
    await Promise.all(written.splice(0).map((p) => unlink(p).catch(() => {})));
  });
  afterAll(async () => {
    registry.kill('7');
    await app.close();
  });

  for (const ct of ['application/json', 'text/plain', 'text/html', 'application/octet-stream']) {
    it(`saves a body labelled ${ct} byte for byte`, async () => {
      const payload = '{"chave":"valor \u2014 acentuado"}';
      const res = await app.inject({
        method: 'POST',
        url: '/upload?session=7&filename=t.json',
        headers: { 'content-type': ct },
        payload,
      });
      expect(res.statusCode).toBe(200);
      const { path } = res.json() as { path: string };
      written.push(path);
      expect(await readFile(path, 'utf8')).toBe(payload);
    });
  }
});

describe('POST /upload — maxUploadBytes: 0 lifts the cap', () => {
  // 0 is the user taking the limit off deliberately, not a value to reject.
  let app: FastifyInstance;
  let registry: SessionRegistry;
  const written: string[] = [];

  beforeAll(async () => {
    const cfg = { ...baseCfg, auth: false, maxUploadBytes: 0 };
    registry = createSessionRegistry(cfg, memoryTabsStore());
    app = await createServer(cfg, secret, registry);
    registry.get('7');
  });
  afterEach(async () => {
    await Promise.all(written.splice(0).map((p) => unlink(p).catch(() => {})));
  });
  afterAll(async () => {
    registry.kill('7');
    await app.close();
  });

  it('accepts a body far past the default cap', async () => {
    const payload = Buffer.alloc(DEFAULT_APP_CONFIG.maxUploadBytes + 1024, 0x61);
    const res = await app.inject({
      method: 'POST',
      url: '/upload?session=7&filename=big.bin',
      headers: { 'content-type': 'application/octet-stream' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const { path } = res.json() as { path: string };
    written.push(path);
    expect((await readFile(path)).length).toBe(payload.length);
  });
});
