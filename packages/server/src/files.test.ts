// File browser backend: unconfined absolute listing, entry metadata (symlinks
// included), the punctuation-significant sort, and the route's status mapping.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import { createServer, createSessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';
import { listDir, type DirListing } from './files';

// `files.ts` calls `lstat` per-entry so ONE unstat-able entry (e.g. deleted
// between `readdir` and `lstat`) can't be reproduced deterministically on a
// real filesystem — this poisons a single named entry while every other
// call (here and in every other test in this file) passes through to the
// real implementation untouched.
let poisonedName = '';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      if (poisonedName && String(path).endsWith(poisonedName)) {
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return actual.lstat(path);
    },
  };
});

let root: string;
let punctDir: string; // isolated so its fixture can't skew the exact-order assertion below

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'palmux-files-'));
  await mkdir(join(root, 'zsub'));
  await writeFile(join(root, 'zeta.txt'), 'zeta\n');
  // `a_z` vs `ab`: at base sensitivity `_` is ignorable and `ab` sorts first.
  await writeFile(join(root, 'a_z.txt'), 'underscore\n');
  await writeFile(join(root, 'ab.txt'), 'plain\n');
  await symlink(join(root, 'zeta.txt'), join(root, 'link.txt'));
  await symlink(join(root, 'zsub'), join(root, 'dirlink'));
  await symlink(join(root, 'nope'), join(root, 'dangling'));

  punctDir = await mkdtemp(join(tmpdir(), 'palmux-files-punct-'));
  await writeFile(join(punctDir, 'a-b.txt'), '');
  await writeFile(join(punctDir, 'a_b.txt'), '');
  await writeFile(join(punctDir, 'a.txt'), '');
  await writeFile(join(punctDir, 'B.txt'), '');
  await writeFile(join(punctDir, 'c.txt'), '');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(punctDir, { recursive: true, force: true });
});

const names = (l: DirListing): string[] => l.entries.map((e) => e.name);

describe('listDir', () => {
  it('lists an absolute directory with per-entry metadata', async () => {
    const res = await listDir(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.listing.path).toBe(root);
    expect(res.listing.parent).toBe(tmpdir());
    const zeta = res.listing.entries.find((e) => e.name === 'zeta.txt');
    expect(zeta).toMatchObject({ dir: false, symlink: false, size: 5 });
    expect(zeta?.mtime).toBeGreaterThan(0);
    expect(res.listing.entries.find((e) => e.name === 'zsub')).toMatchObject({ dir: true });
  });

  it('sorts directories first, then case-insensitively with punctuation significant', async () => {
    const res = await listDir(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Both dirs lead despite sorting last alphabetically; `a_z` beats `ab`.
    expect(names(res.listing)).toEqual([
      'dirlink',
      'zsub',
      'a_z.txt',
      'ab.txt',
      'dangling',
      'link.txt',
      'zeta.txt',
    ]);
  });

  it('sorts case-insensitively with punctuation significant: a-b before a_b, B between a and c', async () => {
    const res = await listDir(punctDir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const list = names(res.listing);
    expect(list.indexOf('a-b.txt')).toBeLessThan(list.indexOf('a_b.txt'));
    expect(list.indexOf('B.txt')).toBeGreaterThan(list.indexOf('a.txt'));
    expect(list.indexOf('B.txt')).toBeLessThan(list.indexOf('c.txt'));
  });

  it('skips an entry that cannot be lstat-ed, still listing the others', async () => {
    poisonedName = 'zeta.txt';
    try {
      const res = await listDir(root);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(names(res.listing)).not.toContain('zeta.txt');
      // its siblings are unaffected — one bad entry doesn't blank the directory
      expect(names(res.listing)).toContain('ab.txt');
      expect(names(res.listing)).toContain('zsub');
    } finally {
      poisonedName = '';
    }
  });

  it('flags symlinks, resolves one to a directory, and survives a broken one', async () => {
    const res = await listDir(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.listing.entries.find((e) => e.name === 'link.txt')).toMatchObject({
      symlink: true,
      dir: false,
    });
    expect(res.listing.entries.find((e) => e.name === 'dirlink')).toMatchObject({
      symlink: true,
      dir: true,
    });
    expect(res.listing.entries.find((e) => e.name === 'dangling')).toMatchObject({
      symlink: true,
      dir: false,
    });
  });

  it('reports no parent at the filesystem root', async () => {
    const res = await listDir('/');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.listing.parent).toBeNull();
  });

  // An ABSENT dir means home — the client cannot guess a home directory, and
  // without this the tree opened at '/' and cost four expands on every open. An
  // EMPTY string is still an error: that is a caller passing a broken value, not
  // a caller declining to pass one, and silently listing home would hide the bug.
  it('lists the home directory when dir is absent', async () => {
    const res = await listDir(undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.listing.path).toBe(homedir());
  });

  it('refuses an empty or relative dir with 400', async () => {
    expect(await listDir('   ')).toMatchObject({
      ok: false,
      status: 400,
      message: 'dir is required',
    });
    expect(await listDir('relative/path')).toMatchObject({
      ok: false,
      status: 400,
      message: 'dir must be absolute',
    });
  });

  it('404s a path that does not exist, 400s a file path with a readable message', async () => {
    expect(await listDir(join(root, 'nope'))).toMatchObject({
      ok: false,
      status: 404,
      message: 'not found',
    });
    const fileRes = await listDir(join(root, 'zeta.txt'));
    expect(fileRes).toMatchObject({ ok: false, status: 400, message: 'not a directory' });
    if (!fileRes.ok) expect(fileRes.message).toMatch(/directory/i);
  });
});

describe('GET /files/list', () => {
  const secret = 'a'.repeat(64);
  let app: FastifyInstance;

  beforeAll(async () => {
    const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: true };
    app = await createServer(cfg, secret, createSessionRegistry(cfg, memoryTabsStore()));
  });
  afterAll(async () => {
    await app.close();
  });

  const cookies = { [SESSION_COOKIE]: secret };

  it('sits behind the cookie gate', async () => {
    const res = await app.inject({ url: `/files/list?dir=${encodeURIComponent(root)}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns the listing as JSON', async () => {
    const res = await app.inject({
      url: `/files/list?dir=${encodeURIComponent(root)}`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DirListing;
    expect(body.path).toBe(root);
    expect(names(body)).toContain('zeta.txt');
  });

  it('answers a JSON error rather than the SPA shell', async () => {
    // No dir at all is now the home listing, so the "not the SPA shell" claim is
    // made with an EMPTY dir, which is still an error.
    const missing = await app.inject({ url: '/files/list?dir=', cookies });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: string }).error).toBeTruthy();

    const gone = await app.inject({
      url: `/files/list?dir=${encodeURIComponent(join(root, 'nope'))}`,
      cookies,
    });
    expect(gone.statusCode).toBe(404);
    expect((gone.json() as { error: string }).error).toBeTruthy();

    const file = await app.inject({
      url: `/files/list?dir=${encodeURIComponent(join(root, 'zeta.txt'))}`,
      cookies,
    });
    expect(file.statusCode).toBe(400);
    expect((file.json() as { error: string }).error).toBeTruthy();
  });
});
