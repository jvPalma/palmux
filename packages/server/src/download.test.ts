// /download: absolute-path/glob resolution, the dependency-free ZIP writer
// (validated by parsing our own output and inflating an entry), and the route
// (auth gate, single-file stream, glob→zip, error codes).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import { createServer, createSessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';
import {
  buildZip,
  bundleZip,
  contentDisposition,
  globBase,
  isGlobPattern,
  resolveDownload,
} from './download';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'palmux-dl-'));
  await writeFile(join(dir, 'a.md'), '# alpha\n');
  await writeFile(join(dir, 'b.md'), '# beta\n');
  await writeFile(join(dir, 'c.txt'), 'not markdown\n');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'd.md'), '# delta\n');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('glob helpers', () => {
  it('classifies glob patterns', () => {
    expect(isGlobPattern('/a/b/*.md')).toBe(true);
    expect(isGlobPattern('/a/b?.md')).toBe(true);
    expect(isGlobPattern('/a/b/c.md')).toBe(false);
  });

  it('globBase is the static prefix', () => {
    expect(globBase('/a/b/*.md')).toBe('/a/b');
    expect(globBase('/a/*/c.md')).toBe('/a');
  });
});

describe('resolveDownload', () => {
  it('rejects relative and empty paths', async () => {
    expect(await resolveDownload('notes/a.md')).toMatchObject({ kind: 'error', status: 400 });
    expect(await resolveDownload('  ')).toMatchObject({ kind: 'error', status: 400 });
  });

  it('404s a missing path and an empty glob', async () => {
    expect(await resolveDownload(join(dir, 'nope.md'))).toMatchObject({
      kind: 'error',
      status: 404,
    });
    expect(await resolveDownload(join(dir, '*.pdf'))).toMatchObject({
      kind: 'error',
      status: 404,
    });
  });

  it('resolves a single file directly', async () => {
    expect(await resolveDownload(join(dir, 'a.md'))).toMatchObject({
      kind: 'file',
      name: 'a.md',
    });
  });

  it('a glob matching ONE file resolves as a plain file, not a zip', async () => {
    expect(await resolveDownload(join(dir, 'c.*'))).toMatchObject({ kind: 'file', name: 'c.txt' });
  });

  it('a multi-match glob resolves to a zip set with the right base', async () => {
    const res = await resolveDownload(join(dir, '*.md'));
    expect(res).toMatchObject({ kind: 'zip', base: dir });
    if (res.kind === 'zip') {
      expect(res.files.map((f) => f.split('/').pop())).toEqual(['a.md', 'b.md']);
      expect(res.zipName.endsWith('.zip')).toBe(true);
    }
  });

  it('a directory resolves to a recursive zip set', async () => {
    const res = await resolveDownload(dir);
    expect(res).toMatchObject({ kind: 'zip' });
    if (res.kind === 'zip') {
      expect(res.files.length).toBe(4); // a.md b.md c.txt sub/d.md
      expect(res.zipName).toBe(`${dir.split('/').pop()}.zip`);
    }
  });
});

describe('buildZip / bundleZip', () => {
  it('produces a parseable archive whose entries inflate back to the input', () => {
    const zip = buildZip([
      { name: 'x/a.md', data: Buffer.from('# alpha alpha alpha alpha\n') },
      { name: 'b.bin', data: Buffer.from([0x00, 0x01]) },
    ]);
    // Local header signature at 0, EOCD signature at the tail, entry count 2.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
    // Walk entry 1: header + name + payload; method 8 → inflate round-trips.
    const method = zip.readUInt16LE(8);
    const compSize = zip.readUInt32LE(18);
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString()).toBe('x/a.md');
    const payload = zip.subarray(30 + nameLen, 30 + nameLen + compSize);
    const content = method === 8 ? inflateRawSync(payload) : payload;
    expect(content.toString()).toBe('# alpha alpha alpha alpha\n');
  });

  it('bundleZip names entries relative to the base', async () => {
    const zip = await bundleZip(dir, [join(dir, 'a.md'), join(dir, 'sub', 'd.md')]);
    const names = zip.toString('latin1');
    expect(names).toContain('a.md');
    expect(names).toContain('sub/d.md');
  });
});

describe('contentDisposition', () => {
  it('quotes an ascii fallback and utf-8-encodes the real name', () => {
    expect(contentDisposition('reprodução.zip')).toBe(
      `attachment; filename="reprodu__o.zip"; filename*=UTF-8''${encodeURIComponent('reprodução.zip')}`,
    );
  });
});

describe('GET /download (route)', () => {
  const baseCfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [] };
  const secret = 'a'.repeat(64);
  let app: FastifyInstance;

  beforeAll(async () => {
    const cfg = { ...baseCfg, auth: true };
    app = await createServer(cfg, secret, createSessionRegistry(cfg, memoryTabsStore()));
  });
  afterAll(async () => {
    await app.close();
  });

  const cookies = { [SESSION_COOKIE]: secret };

  it('is behind the cookie gate', async () => {
    const res = await app.inject({ method: 'GET', url: `/download?path=${dir}/a.md` });
    expect(res.statusCode).toBe(401);
  });

  it('streams a single file with an attachment disposition', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/download?path=${encodeURIComponent(join(dir, 'a.md'))}`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('filename="a.md"');
    expect(res.body).toBe('# alpha\n');
  });

  it('zips a glob (PK magic + zip content type + derived name)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/download?path=${encodeURIComponent(join(dir, '*.md'))}`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('.zip');
    expect(res.rawPayload.readUInt32LE(0)).toBe(0x04034b50);
  });

  it('maps resolution errors to their statuses', async () => {
    const rel = await app.inject({ method: 'GET', url: '/download?path=oops.md', cookies });
    expect(rel.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'GET',
      url: `/download?path=${encodeURIComponent(join(dir, 'zzz', '*.md'))}`,
      cookies,
    });
    expect(missing.statusCode).toBe(404);
  });
});
