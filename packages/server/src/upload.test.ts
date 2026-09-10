import { describe, expect, it, afterEach } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import { sanitizeFilename, saveUpload, sniffImageExtension } from './upload';

describe('sanitizeFilename', () => {
  it('keeps a normal basename intact', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('My File 2.png')).toBe('My_File_2.png');
  });

  it('strips directory components (both separators)', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\secret.txt')).toBe('secret.txt');
  });

  it('neutralizes traversal and leading/trailing punctuation', () => {
    expect(sanitizeFilename('../../..')).toBe('file');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('__init__')).toBe('init'); // trims leading/trailing underscores
  });

  it('falls back to "file" for an empty/garbage name', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('///')).toBe('file');
  });

  it('truncates an over-long name but keeps its extension', () => {
    const long = `${'a'.repeat(300)}.txt`;
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.txt')).toBe(true);
  });
});

describe('sniffImageExtension', () => {
  it('detects PNG/JPEG/GIF/WebP magic bytes', () => {
    expect(
      sniffImageExtension(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('.png');
    expect(sniffImageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe('.jpg');
    expect(sniffImageExtension(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe('.gif');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageExtension(webp)).toBe('.webp');
  });

  it('returns "" for non-image bytes', () => {
    expect(sniffImageExtension(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(''); // %PDF
  });
});

describe('saveUpload', () => {
  const written: string[] = [];
  afterEach(async () => {
    await Promise.all(written.splice(0).map((p) => unlink(p).catch(() => {})));
  });

  it('writes the bytes and keeps a sanitized named basename in the path', async () => {
    const path = await saveUpload(Buffer.from('hello world'), '../notes.txt');
    written.push(path);
    expect(path).toContain('palmux-clip-');
    expect(path.endsWith('-notes.txt')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('hello world');
  });

  it('sniffs an image extension when no filename is given', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const path = await saveUpload(png);
    written.push(path);
    expect(path.endsWith('.png')).toBe(true);
  });

  it('generates unique paths for repeated uploads of the same name', async () => {
    const a = await saveUpload(Buffer.from('a'), 'dup.txt');
    const b = await saveUpload(Buffer.from('b'), 'dup.txt');
    written.push(a, b);
    expect(a).not.toBe(b);
  });
});
