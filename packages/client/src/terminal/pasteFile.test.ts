import { describe, expect, it } from 'vitest';
import { extractPasteImage, firstFile } from './pasteFile';

// Minimal DataTransfer-ish stand-ins: the extractors only touch `items` (with
// kind/type/getAsFile) and `files`.
const fileItem = (file: File) => ({ kind: 'file', type: file.type, getAsFile: () => file });
const stringItem = (type: string) => ({ kind: 'string', type, getAsFile: () => null });

const dt = (items: unknown[], files: File[] = []) => ({ items, files }) as unknown as DataTransfer;

const png = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
const pdf = new File([new Uint8Array([1])], 'doc.pdf', { type: 'application/pdf' });

describe('extractPasteImage', () => {
  it('returns the first image file from items', () => {
    expect(extractPasteImage(dt([stringItem('text/plain'), fileItem(png)]))).toBe(png);
  });

  it('ignores non-image files', () => {
    expect(extractPasteImage(dt([fileItem(pdf)]))).toBeNull();
  });

  it('falls back to files[] when items is absent', () => {
    expect(extractPasteImage({ files: [png] } as unknown as DataTransfer)).toBe(png);
  });

  it('returns null for null/empty transfers', () => {
    expect(extractPasteImage(null)).toBeNull();
    expect(extractPasteImage(dt([]))).toBeNull();
  });
});

describe('firstFile', () => {
  it('returns the first file of ANY type', () => {
    expect(firstFile(dt([stringItem('text/plain'), fileItem(pdf)]))).toBe(pdf);
  });

  it('skips string items', () => {
    expect(firstFile(dt([stringItem('text/uri-list')]))).toBeNull();
  });

  it('falls back to files[0]', () => {
    expect(firstFile({ items: null, files: [pdf] } as unknown as DataTransfer)).toBe(pdf);
  });

  it('returns null for null transfers', () => {
    expect(firstFile(null)).toBeNull();
  });
});
