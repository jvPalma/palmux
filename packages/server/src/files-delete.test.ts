// Deleting from the Explorer. The refusals here do not stop an attacker — the
// cookie already grants a shell — they stop a MISTAKE, which a two-click context
// menu makes easy in a way `rm` does not. There is no trash, so every one of
// these is the only thing standing between a misclick and lost data.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deletePath, deletePaths, MAX_DELETE_PATHS } from './files';

const dirs: string[] = [];
const sandbox = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'palmux-del-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('deletePath', () => {
  it('removes a file and says so', async () => {
    const d = sandbox();
    const f = join(d, 'note.txt');
    writeFileSync(f, 'x');
    const r = await deletePath(f);
    expect(r).toMatchObject({ ok: true, kind: 'file' });
    expect(existsSync(f)).toBe(false);
  });

  it('removes a directory recursively and reports what it held', async () => {
    const d = sandbox();
    const sub = join(d, 'pkg');
    mkdirSync(join(sub, 'deep'), { recursive: true });
    writeFileSync(join(sub, 'a.txt'), 'a');
    writeFileSync(join(sub, 'deep', 'b.txt'), 'b');
    const r = await deletePath(sub);
    expect(r).toMatchObject({ ok: true, kind: 'directory', entries: 2 });
    expect(existsSync(sub)).toBe(false);
  });

  // Following the link would empty the directory it points at — the worst
  // possible outcome for an operation with no undo.
  it('removes a symlink as a link, never its target', async () => {
    const d = sandbox();
    const target = join(d, 'real');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    const link = join(d, 'link');
    symlinkSync(target, link);

    const r = await deletePath(link);
    expect(r.ok).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  it('refuses the filesystem root, the home directory and any top-level path', async () => {
    for (const p of ['/', homedir(), '/etc', '/usr', '/home']) {
      const r = await deletePath(p);
      expect(r.ok, p).toBe(false);
      expect(!r.ok && r.message, p).toMatch(/refusing/);
    }
  });

  // `/home/user/../..` normalises to `/`, so the refusal has to run on the
  // RESOLVED path or it is trivially sidestepped.
  it('refuses a traversal that resolves to a refused path', async () => {
    const r = await deletePath(`${homedir()}/../..`);
    expect(r.ok).toBe(false);
  });

  it('refuses a relative path and an empty one', async () => {
    for (const p of ['relative/thing', '', '   ', null, undefined, 42]) {
      expect((await deletePath(p)).ok, String(p)).toBe(false);
    }
  });

  it('reports a missing path instead of pretending it worked', async () => {
    const r = await deletePath(join(sandbox(), 'ghost'));
    expect(r).toMatchObject({ ok: false, message: 'no such file or directory' });
  });
});

describe('deletePaths', () => {
  it('reports each path independently, so one failure does not abandon the rest', async () => {
    const d = sandbox();
    const good = join(d, 'a.txt');
    writeFileSync(good, 'a');
    const missing = join(d, 'nope.txt');
    const other = join(d, 'b.txt');
    writeFileSync(other, 'b');

    const res = await deletePaths([good, missing, other]);
    expect(Array.isArray(res)).toBe(true);
    const list = res as Awaited<ReturnType<typeof deletePath>>[];
    expect(list.map((r) => r.ok)).toEqual([true, false, true]);
    expect(existsSync(good)).toBe(false);
    expect(existsSync(other)).toBe(false);
  });

  // A directory and something inside it in the same batch: sequential deletion
  // makes the second a clean "no such file", not a race.
  it('handles a directory and its own child in one batch', async () => {
    const d = sandbox();
    const sub = join(d, 'pkg');
    mkdirSync(sub);
    const child = join(sub, 'c.txt');
    writeFileSync(child, 'c');
    const res = (await deletePaths([sub, child])) as Awaited<ReturnType<typeof deletePath>>[];
    expect(res[0]?.ok).toBe(true);
    expect(res[1]?.ok).toBe(false);
    expect(existsSync(sub)).toBe(false);
  });

  it('rejects a malformed or oversized request as a whole', async () => {
    expect(await deletePaths([])).toEqual({ error: expect.stringContaining('non-empty') });
    expect(await deletePaths('nope')).toEqual({ error: expect.stringContaining('non-empty') });
    const many = Array.from({ length: MAX_DELETE_PATHS + 1 }, (_, i) => `/tmp/x${i}`);
    expect(await deletePaths(many)).toEqual({ error: expect.stringContaining('too many') });
  });
});
