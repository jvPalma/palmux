// Markdown viewer backend: capped typed reads, roots-confined listing (incl.
// symlink escape attempts), and the routes' status mapping + auth gate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import { createServer, createSessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';
import { isMarkdownFile, listMdDir, MAX_MD_FILE_BYTES, readMdFile } from './markdown';

let root: string; // configured markdownRoot
let outside: string; // sibling dir NOT in the roots

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'palmux-md-root-'));
  outside = await mkdtemp(join(tmpdir(), 'palmux-md-out-'));
  await writeFile(join(root, 'index.md'), '# hello\n[next](./sub/next.md)\n');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'next.md'), '# next\n');
  await writeFile(join(root, 'notes.txt'), 'not markdown\n');
  await writeFile(join(root, '.hidden.md'), 'dot\n');
  await writeFile(join(outside, 'secret.md'), 'outside\n');
  // A symlink INSIDE the root pointing OUTSIDE it — listing must refuse it.
  await symlink(outside, join(root, 'escape'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('isMarkdownFile', () => {
  it('accepts md/markdown/mdx, case-insensitive; rejects the rest', () => {
    expect(isMarkdownFile('a.md')).toBe(true);
    expect(isMarkdownFile('a.MARKDOWN')).toBe(true);
    expect(isMarkdownFile('a.mdx')).toBe(true);
    expect(isMarkdownFile('a.txt')).toBe(false);
    expect(isMarkdownFile('md')).toBe(false);
  });
});

describe('readMdFile', () => {
  it('reads a file with a text content type', async () => {
    const res = await readMdFile(join(root, 'index.md'));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.type).toContain('text/plain');
      expect(res.data.toString()).toContain('# hello');
    }
  });

  it('maps relative/missing/oversize to 400/404/413', async () => {
    expect(await readMdFile('relative.md')).toMatchObject({ ok: false, status: 400 });
    expect(await readMdFile(join(root, 'nope.md'))).toMatchObject({ ok: false, status: 404 });
    const big = join(outside, 'big.md');
    await writeFile(big, Buffer.alloc(MAX_MD_FILE_BYTES + 1));
    expect(await readMdFile(big)).toMatchObject({ ok: false, status: 413 });
  });

  it('serves images with an image content type (relative srcs)', async () => {
    const png = join(outside, 'pic.png');
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await readMdFile(png)).toMatchObject({ ok: true, type: 'image/png' });
  });
});

describe('listMdDir (roots confinement)', () => {
  it('refuses everything when no roots are configured', async () => {
    expect(await listMdDir(undefined, [])).toMatchObject({ ok: false, status: 404 });
  });

  it('the overview lists existing roots', async () => {
    const res = await listMdDir(undefined, [root, '/definitely/missing']);
    expect(res).toMatchObject({ ok: true });
    if (res.ok)
      expect(res.listing).toMatchObject({ dir: null, root: null, dirs: [root], files: [] });
  });

  it('lists markdown files + dirs inside a root, skipping dotfiles', async () => {
    const res = await listMdDir(root, [root]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.listing.files).toEqual([join(root, 'index.md')]); // not notes.txt/.hidden.md
      expect(res.listing.dirs).toContain(join(root, 'sub'));
      expect(res.listing.root).toBe(root); // the containing root (for UI breadcrumb clamping)
    }
  });

  it('refuses a directory outside every root', async () => {
    expect(await listMdDir(outside, [root])).toMatchObject({ ok: false, status: 403 });
    expect(await listMdDir('/', [root])).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a symlink escape (realpath wins over the textual prefix)', async () => {
    // <root>/escape textually sits inside the root but realpaths outside it.
    expect(await listMdDir(join(root, 'escape'), [root])).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('relative dir is a 400', async () => {
    expect(await listMdDir('sub', [root])).toMatchObject({ ok: false, status: 400 });
  });
});

describe('routes', () => {
  const secret = 'a'.repeat(64);
  let app: FastifyInstance;

  beforeAll(async () => {
    const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: true, markdownRoots: [] };
    // markdownRoots is read at request time from cfg — set it post-construction
    // to the test root (same object identity).
    cfg.markdownRoots = [root];
    app = await createServer(cfg, secret, createSessionRegistry(cfg, memoryTabsStore()));
  });
  afterAll(async () => {
    await app.close();
  });

  const cookies = { [SESSION_COOKIE]: secret };

  it('both routes sit behind the cookie gate', async () => {
    expect((await app.inject({ url: `/md-file?path=${root}/index.md` })).statusCode).toBe(401);
    expect((await app.inject({ url: '/md-list' })).statusCode).toBe(401);
  });

  it('md-file returns the raw markdown', async () => {
    const res = await app.inject({
      url: `/md-file?path=${encodeURIComponent(join(root, 'index.md'))}`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# hello');
  });

  it('md-list walks the tree and refuses escapes', async () => {
    const top = await app.inject({ url: '/md-list', cookies });
    expect(top.statusCode).toBe(200);
    expect((top.json() as { dirs: string[] }).dirs).toEqual([root]);
    const sub = await app.inject({
      url: `/md-list?dir=${encodeURIComponent(join(root, 'sub'))}`,
      cookies,
    });
    expect((sub.json() as { files: string[] }).files).toEqual([join(root, 'sub', 'next.md')]);
    const out = await app.inject({ url: `/md-list?dir=${encodeURIComponent(outside)}`, cookies });
    expect(out.statusCode).toBe(403);
  });
});
