import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { resolveImageFile } from './image-file';
import { createServer, createSessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';

// A 1x1 png: the bytes are irrelevant to the gate, the extension is.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'palmux-image-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveImageFile', () => {
  it('accepts an existing regular file with an image extension', async () => {
    const f = join(tmp(), 'shot.png');
    writeFileSync(f, PNG);
    const r = await resolveImageFile(f);
    expect(r).toMatchObject({ ok: true, contentType: 'image/png' });
  });

  it('rejects a non-image extension before touching the disk', async () => {
    const r = await resolveImageFile('/definitely/not/here.txt');
    expect(r).toMatchObject({ ok: false, status: 400, message: 'not an image file' });
  });

  it('rejects a relative path, a missing file and a directory, each distinctly', async () => {
    const d = tmp();
    expect(await resolveImageFile('rel/a.png')).toMatchObject({ ok: false, status: 400 });
    expect(await resolveImageFile(join(d, 'nope.png'))).toMatchObject({ ok: false, status: 404 });
    // A DIRECTORY that names an image passes the extension gate and is caught
    // by the regular-file gate — the same layering /file has.
    mkdirSync(join(d, 'dir.png'));
    expect(await resolveImageFile(join(d, 'dir.png'))).toMatchObject({
      ok: false,
      status: 400,
      message: 'path is a directory',
    });
  });
});

describe('GET /file-image', () => {
  let app: FastifyInstance;
  let prevConfigDir: string | undefined;

  beforeAll(async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'palmux-imagecfg-'));
    prevConfigDir = process.env['PALMUX_CONFIG_DIR'];
    process.env['PALMUX_CONFIG_DIR'] = configDir;
    const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
    const registry = createSessionRegistry(cfg, memoryTabsStore());
    app = await createServer(cfg, 'a'.repeat(64), registry);
  });

  afterAll(async () => {
    if (prevConfigDir === undefined) delete process.env['PALMUX_CONFIG_DIR'];
    else process.env['PALMUX_CONFIG_DIR'] = prevConfigDir;
    await app.close();
  });

  it('streams the bytes with the right content type', async () => {
    const f = join(tmp(), 'pic.png');
    writeFileSync(f, PNG);
    const res = await app.inject({ method: 'GET', url: `/file-image?path=${encodeURIComponent(f)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.rawPayload).equals(PNG)).toBe(true);
  });

  it('answers JSON errors, not bytes, for a refused path', async () => {
    const res = await app.inject({ method: 'GET', url: '/file-image?path=%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'not an image file' });
    const missing = await app.inject({ method: 'GET', url: '/file-image?path=%2Fnope%2Fgone.png' });
    expect(missing.statusCode).toBe(404);
  });
});
