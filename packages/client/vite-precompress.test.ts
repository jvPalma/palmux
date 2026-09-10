// What gets a .gz/.br sibling, and what deliberately does not. The plugin runs
// at build time only, so this tests the pure directory walk underneath it.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { precompressDir } from './vite-precompress';

const dirs: string[] = [];
const fixture = (files: Record<string, string | number>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'palmux-precomp-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof body === 'number' ? 'x'.repeat(body) : body);
  }
  return dir;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('precompressDir', () => {
  it('writes both codecs for a compressible file', async () => {
    const dir = fixture({ 'assets/app.js': 5000 });
    const r = await precompressDir(dir);
    expect(r.files).toBe(1);
    expect(existsSync(join(dir, 'assets/app.js.gz'))).toBe(true);
    expect(existsSync(join(dir, 'assets/app.js.br'))).toBe(true);
    // Highly repetitive input — both must actually be smaller, or the sibling
    // is pure cost.
    expect(r.gzip).toBeLessThan(r.raw);
    expect(r.brotli).toBeLessThan(r.gzip);
  });

  it('recurses', async () => {
    const dir = fixture({ 'a/b/c/deep.css': 4000 });
    await precompressDir(dir);
    expect(existsSync(join(dir, 'a/b/c/deep.css.br'))).toBe(true);
  });

  // woff2 is brotli inside and png/jpg carry their own codec: compressing them
  // costs two files and saves nothing. This is why the font is still the single
  // largest thing in a cold load and needs subsetting, not compression.
  it('skips formats that are already compressed', async () => {
    const dir = fixture({ 'f.woff2': 9000, 'i.png': 9000, 'v.mp4': 9000 });
    const r = await precompressDir(dir);
    expect(r.files).toBe(0);
    expect(existsSync(join(dir, 'f.woff2.br'))).toBe(false);
  });

  it('skips anything under the size floor', async () => {
    const dir = fixture({ 'tiny.svg': 200, 'big.svg': 4000 });
    const r = await precompressDir(dir);
    expect(r.files).toBe(1);
    expect(existsSync(join(dir, 'tiny.svg.br'))).toBe(false);
    expect(existsSync(join(dir, 'big.svg.br'))).toBe(true);
  });

  // Re-running a build must not compress last run's output into .gz.gz.
  it('never compresses its own siblings', async () => {
    const dir = fixture({ 'app.js': 4000 });
    await precompressDir(dir);
    const second = await precompressDir(dir);
    expect(second.files).toBe(1);
    expect(existsSync(join(dir, 'app.js.gz.gz'))).toBe(false);
    expect(existsSync(join(dir, 'app.js.br.br'))).toBe(false);
  });

  it('leaves the original untouched', async () => {
    const dir = fixture({ 'app.js': 4000 });
    const before = statSync(join(dir, 'app.js')).size;
    await precompressDir(dir);
    expect(statSync(join(dir, 'app.js')).size).toBe(before);
  });
});
