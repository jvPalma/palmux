// Deleting from the Explorer. The refusals here do not stop an attacker — the
// cookie already grants a shell — they stop a MISTAKE, which a two-click context
// menu makes easy in a way `rm` does not. There is no trash, so every one of
// these is the only thing standing between a misclick and lost data.

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
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

// ── A path is used exactly as given (batch 11) ────────────────────────────────
//
// `report ` and `report` are two different directories. The route used to trim the
// request and resolve it against the server's cwd, so a Delete on the row `report `
// removed its sibling `report` — and a RELATIVE request was anchored to wherever the
// process happened to be started, which made `deletePath('packages/client')` remove a
// directory of the running checkout. Every request string below ENDS in whitespace
// (or starts with it, or is relative): a trim changes nothing for a value that merely
// contains a space in the middle.
describe('deletePath uses the path exactly as given', () => {
  const siblings = (): { d: string; plain: string; spaced: string } => {
    const d = sandbox();
    const plain = join(d, 'report');
    const spaced = join(d, 'report ');
    mkdirSync(plain);
    mkdirSync(spaced);
    writeFileSync(join(plain, 'plain.txt'), 'plain');
    writeFileSync(join(spaced, 'spaced.txt'), 'spaced');
    return { d, plain, spaced };
  };

  it('deleting `report ` removes that directory only and leaves `report` intact', async () => {
    const { plain, spaced } = siblings();
    const r = await deletePath(spaced);
    expect(r).toMatchObject({ ok: true, kind: 'directory', entries: 1 });
    expect(r.path).toBe(spaced);
    expect(existsSync(spaced)).toBe(false);
    expect(readFileSync(join(plain, 'plain.txt'), 'utf8')).toBe('plain');
  });

  it('deleting `report` removes that directory only and leaves `report ` intact', async () => {
    const { plain, spaced } = siblings();
    const r = await deletePath(plain);
    expect(r).toMatchObject({ ok: true, kind: 'directory', entries: 1 });
    expect(existsSync(plain)).toBe(false);
    expect(readFileSync(join(spaced, 'spaced.txt'), 'utf8')).toBe('spaced');
  });

  it('deletes the file `x ` and never its sibling `x`, and the other way round', async () => {
    const d = sandbox();
    writeFileSync(join(d, 'x'), 'plain');
    writeFileSync(join(d, 'x '), 'spaced');
    expect(await deletePath(join(d, 'x '))).toMatchObject({ ok: true, kind: 'file' });
    expect(existsSync(join(d, 'x '))).toBe(false);
    expect(readFileSync(join(d, 'x'), 'utf8')).toBe('plain');

    writeFileSync(join(d, 'x '), 'spaced');
    expect(await deletePath(join(d, 'x'))).toMatchObject({ ok: true, kind: 'file' });
    expect(existsSync(join(d, 'x'))).toBe(false);
    expect(readFileSync(join(d, 'x '), 'utf8')).toBe('spaced');
  });

  it('reports a trailing-space path that does not exist instead of deleting its sibling', async () => {
    const d = sandbox();
    writeFileSync(join(d, 'only'), 'keep');
    const r = await deletePath(join(d, 'only '));
    expect(r).toMatchObject({ ok: false, message: 'no such file or directory' });
    expect(readFileSync(join(d, 'only'), 'utf8')).toBe('keep');
  });

  // A leading space makes the string relative. Trimming it first used to repair it
  // into an absolute path and act.
  it('refuses a path with leading whitespace instead of repairing it', async () => {
    const d = sandbox();
    const f = join(d, 'lead.txt');
    writeFileSync(f, 'keep');
    const r = await deletePath(` ${f}`);
    expect(r).toMatchObject({ ok: false, message: 'path must be absolute' });
    expect(existsSync(f)).toBe(true);
  });

  // B11-01. `resolve()` turns ANY string into an absolute one under the cwd, so an
  // `isAbsolute` check that runs after it can never refuse.
  it('refuses a relative path that names an existing target under the process cwd', async () => {
    const cwd = sandbox();
    mkdirSync(join(cwd, 'packages', 'client'), { recursive: true });
    writeFileSync(join(cwd, 'packages', 'client', 'sentinel'), 'keep');
    const before = process.cwd();
    process.chdir(cwd);
    try {
      for (const rel of ['packages/client', 'packages', './packages/client', 'packages/../packages']) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal must land before the next
        const r = await deletePath(rel);
        expect(r, rel).toMatchObject({ ok: false, message: 'path must be absolute' });
        expect(r.path, rel).toBe(rel); // names what was asked, not a path under the cwd
      }
    } finally {
      process.chdir(before);
    }
    expect(readFileSync(join(cwd, 'packages', 'client', 'sentinel'), 'utf8')).toBe('keep');
  });

  it('still answers a blank item as a per-path failure, inside a mixed batch', async () => {
    const d = sandbox();
    const good = join(d, 'good.txt');
    const other = join(d, 'other.txt');
    writeFileSync(good, 'g');
    writeFileSync(other, 'o');

    const res = await deletePaths([good, '', '   ', 'relative/x', other]);
    expect(Array.isArray(res)).toBe(true);
    const list = res as Awaited<ReturnType<typeof deletePath>>[];
    expect(list.map((r) => r.ok)).toEqual([true, false, false, false, true]);
    expect(list.map((r) => !r.ok && r.message)).toEqual([
      false,
      'path is required',
      'path is required',
      'path must be absolute',
      false,
    ]);
    expect(existsSync(good)).toBe(false);
    expect(existsSync(other)).toBe(false);
  });
});
