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

// ── A path is used exactly as given (batch 11) ────────────────────────────────
//
// `notes.md` and `notes.md ` are two files, `report` and `report ` two directories. The
// viewer's routes trimmed what they were given before resolving it, so the spaced name
// answered with its sibling. Each request string below ENDS in whitespace.
describe('markdown paths are used exactly as given', () => {
  let base: string; // the configured markdownRoot
  let before: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'palmux-md-exact-'));
    await writeFile(join(base, 'notes.md'), '# plain\n');
    await writeFile(join(base, 'notes.md '), '# spaced\n');
    await writeFile(join(base, 'only.md'), '# only\n');
    await mkdir(join(base, 'report'));
    await mkdir(join(base, 'report '));
    await writeFile(join(base, 'report', 'a.md'), '# a\n');
    await writeFile(join(base, 'report ', 'b.md'), '# b\n');
    await mkdir(join(base, 'solo'));
    await writeFile(join(base, 'solo', 's.md'), '# s\n');
    before = process.cwd();
  });
  afterAll(async () => {
    process.chdir(before);
    await rm(base, { recursive: true, force: true });
  });

  describe('readMdFile', () => {
    it('reads `notes.md ` and `notes.md` as the two files they are', async () => {
      const spaced = await readMdFile(join(base, 'notes.md '));
      expect(spaced.ok && spaced.data.toString()).toBe('# spaced\n');
      const plain = await readMdFile(join(base, 'notes.md'));
      expect(plain.ok && plain.data.toString()).toBe('# plain\n');
    });

    it('404s a trailing-space file that does not exist instead of reading its sibling', async () => {
      expect(await readMdFile(join(base, 'only.md '))).toMatchObject({ ok: false, status: 404 });
    });

    it('refuses leading whitespace and a relative path that exists under the cwd', async () => {
      expect(await readMdFile(` ${join(base, 'notes.md')}`)).toMatchObject({
        ok: false,
        status: 400,
      });
      process.chdir(base);
      try {
        expect(await readMdFile('notes.md ')).toMatchObject({ ok: false, status: 400 });
        expect(await readMdFile('notes.md')).toMatchObject({ ok: false, status: 400 });
      } finally {
        process.chdir(before);
      }
    });

    it('keeps its blank contract: a blank path is a 400', async () => {
      for (const blank of ['', ' ', '\t\n  ']) {
        // oxlint-disable-next-line no-await-in-loop -- independent, order irrelevant
        expect(await readMdFile(blank), JSON.stringify(blank)).toMatchObject({
          ok: false,
          status: 400,
          message: 'path must be absolute',
        });
      }
    });
  });

  describe('listMdDir', () => {
    it('lists exactly `report ` and exactly `report`, inside a root', async () => {
      const spaced = await listMdDir(join(base, 'report '), [base]);
      expect(spaced.ok).toBe(true);
      if (spaced.ok) {
        expect(spaced.listing.dir).toBe(join(base, 'report '));
        expect(spaced.listing.files).toEqual([join(base, 'report ', 'b.md')]);
      }
      const plain = await listMdDir(join(base, 'report'), [base]);
      expect(plain.ok).toBe(true);
      if (plain.ok) expect(plain.listing.files).toEqual([join(base, 'report', 'a.md')]);
    });

    it('404s a trailing-space dir that does not exist instead of listing its sibling', async () => {
      // The confinement check runs on the same untrimmed path, so a missing sibling is
      // refused by it (realpath fails) rather than answered with `solo`'s files.
      const res = await listMdDir(join(base, 'solo '), [base]);
      expect(res.ok).toBe(false);
    });

    it('refuses leading whitespace and a relative dir that exists under the cwd', async () => {
      expect(await listMdDir(` ${join(base, 'report')}`, [base])).toMatchObject({
        ok: false,
        status: 400,
        message: 'dir must be absolute',
      });
      process.chdir(base);
      try {
        expect(await listMdDir('report', [base])).toMatchObject({ ok: false, status: 400 });
      } finally {
        process.chdir(before);
      }
    });

    it('keeps its blank contract: absent or blank is the roots overview', async () => {
      for (const blank of [undefined, '', ' ', '\t\n  ']) {
        // oxlint-disable-next-line no-await-in-loop -- independent, order irrelevant
        const res = await listMdDir(blank, [base]);
        expect(res, JSON.stringify(blank)).toMatchObject({ ok: true });
        if (res.ok) expect(res.listing).toMatchObject({ dir: null, root: null, dirs: [base] });
      }
    });
  });

  describe('through the routes', () => {
    const secret = 'a'.repeat(64);
    let app: FastifyInstance;
    beforeAll(async () => {
      const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: true, markdownRoots: [] };
      cfg.markdownRoots = [base];
      app = await createServer(cfg, secret, createSessionRegistry(cfg, memoryTabsStore()));
    });
    afterAll(async () => {
      await app.close();
    });
    const get = (route: string, key: 'path' | 'dir', value: string) =>
      app.inject({
        url: `${route}?${key}=${encodeURIComponent(value)}`,
        cookies: { [SESSION_COOKIE]: secret },
      });

    it('md-file serves the content of `notes.md `, not of `notes.md`', async () => {
      const spaced = await get('/md-file', 'path', join(base, 'notes.md '));
      expect(spaced.statusCode).toBe(200);
      expect(spaced.body).toBe('# spaced\n');
    });

    it('md-list lists `report ` with its own files', async () => {
      const res = await get('/md-list', 'dir', join(base, 'report '));
      expect(res.statusCode).toBe(200);
      expect((res.json() as { files: string[] }).files).toEqual([join(base, 'report ', 'b.md')]);
    });

    it('answers a blank md-file path with a 400 and a blank md-list dir with the overview', async () => {
      expect((await get('/md-file', 'path', '  ')).statusCode).toBe(400);
      const overview = await get('/md-list', 'dir', '  ');
      expect(overview.statusCode).toBe(200);
      expect((overview.json() as { dirs: string[] }).dirs).toEqual([base]);
    });
  });
});
