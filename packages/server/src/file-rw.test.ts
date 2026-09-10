import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextFile, writeTextFile } from './file-rw';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'palmux-filerw-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CAP = 1024 * 1024;

describe('readTextFile', () => {
  it('reads a regular file', async () => {
    const d = tmp();
    const f = join(d, 'a.md');
    writeFileSync(f, '# hi\n');
    const r = await readTextFile(f, CAP);
    expect(r).toMatchObject({ ok: true, text: '# hi\n', size: 5 });
  });

  it('rejects a relative path, a missing file and a directory, each distinctly', async () => {
    const d = tmp();
    expect(await readTextFile('rel/a.md', CAP)).toMatchObject({ ok: false, status: 400 });
    expect(await readTextFile(join(d, 'nope'), CAP)).toMatchObject({ ok: false, status: 404 });
    expect(await readTextFile(d, CAP)).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a file past the cap rather than loading it', async () => {
    const d = tmp();
    const f = join(d, 'big.txt');
    writeFileSync(f, 'x'.repeat(50));
    const r = await readTextFile(f, 10);
    expect(r).toMatchObject({ ok: false, status: 413 });
  });
});

describe('writeTextFile', () => {
  it('overwrites an existing file and reports the new size', async () => {
    const d = tmp();
    const f = join(d, 'a.txt');
    writeFileSync(f, 'old');
    expect(await writeTextFile(f, 'new content', CAP)).toMatchObject({ ok: true, size: 11 });
    expect((await readTextFile(f, CAP)) as { text: string }).toMatchObject({ text: 'new content' });
  });

  // The refusal that matters most: Edit saves over what the tree showed you and
  // nothing else. A typo in a path must not quietly conjure a new file somewhere.
  it('never CREATES a file', async () => {
    const d = tmp();
    expect(await writeTextFile(join(d, 'new.txt'), 'x', CAP)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('never creates a parent directory', async () => {
    const d = tmp();
    expect(await writeTextFile(join(d, 'deep', 'a.txt'), 'x', CAP)).toMatchObject({ ok: false });
  });

  it('refuses anything that is not a regular file', async () => {
    const d = tmp();
    mkdirSync(join(d, 'sub'));
    expect(await writeTextFile(join(d, 'sub'), 'x', CAP)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('preserves the original mode', async () => {
    const d = tmp();
    const f = join(d, 'x.sh');
    writeFileSync(f, 'old');
    chmodSync(f, 0o750);
    await writeTextFile(f, 'new', CAP);
    expect(statSync(f).mode & 0o777).toBe(0o750);
  });

  // The temp file goes in the TARGET's directory. Renaming across a filesystem
  // fails with EXDEV, so writing to the system temp dir would break for any file
  // on a different mount — which on a normal host means everything under /home.
  it('leaves no temp file behind on success', async () => {
    const d = tmp();
    const f = join(d, 'a.txt');
    writeFileSync(f, 'old');
    await writeTextFile(f, 'new', CAP);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(d).filter((n) => n.includes('palmux-save'))).toEqual([]);
  });

  it('refuses a body past the cap without touching the file', async () => {
    const d = tmp();
    const f = join(d, 'a.txt');
    writeFileSync(f, 'old');
    expect(await writeTextFile(f, 'x'.repeat(50), 10)).toMatchObject({ ok: false, status: 413 });
    expect((await readTextFile(f, CAP)) as { text: string }).toMatchObject({ text: 'old' });
  });

  it('follows a symlink to a regular file, because that is what an editor should do', async () => {
    const d = tmp();
    const real = join(d, 'real.txt');
    const link = join(d, 'link.txt');
    writeFileSync(real, 'old');
    symlinkSync(real, link);
    expect(await writeTextFile(link, 'via link', CAP)).toMatchObject({ ok: true });
    expect((await readTextFile(real, CAP)) as { text: string }).toMatchObject({ text: 'via link' });
  });
});
