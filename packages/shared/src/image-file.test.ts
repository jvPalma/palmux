import { describe, expect, it } from 'vitest';
import { imageContentType, isImageFile } from './image-file';

describe('isImageFile', () => {
  it('recognises image extensions, case-insensitive', () => {
    for (const p of ['a.png', 'a.JPG', 'dir/a.webp', 'a.avif', 'a.svg']) {
      expect(isImageFile(p)).toBe(true);
    }
  });

  it('rejects text, dotless and dotted-nowhere names', () => {
    for (const p of ['a.md', 'a.ts', 'a.tar.gz', 'png', '.png', 'a.png.txt']) {
      expect(isImageFile(p)).toBe(false);
    }
  });
});

describe('imageContentType', () => {
  it('maps every extension to its mime type', () => {
    expect(imageContentType('a.png')).toBe('image/png');
    expect(imageContentType('a.JPEG')).toBe('image/jpeg');
    expect(imageContentType('a.gif')).toBe('image/gif');
    expect(imageContentType('a.svg')).toBe('image/svg+xml');
    expect(imageContentType('a.ico')).toBe('image/x-icon');
  });

  it('answers null for a non-image name', () => {
    expect(imageContentType('a.md')).toBeNull();
    expect(imageContentType('a')).toBeNull();
  });
});
