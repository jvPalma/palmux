// Client download helper: disposition parsing + fallback naming (the fetch →
// anchor flow itself is exercised live; these pin the naming contract).

import { describe, expect, it } from 'vitest';
import { fallbackName, filenameFromDisposition } from './download';

describe('filenameFromDisposition', () => {
  it('prefers the UTF-8 filename* form', () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="repro__o.zip"; filename*=UTF-8''reprodu%C3%A7%C3%A3o.zip`,
        'x',
      ),
    ).toBe('reprodução.zip');
  });

  it('falls back to the quoted filename', () => {
    expect(filenameFromDisposition('attachment; filename="a.md"', 'x')).toBe('a.md');
  });

  it('falls back to the provided default on a missing/mangled header', () => {
    expect(filenameFromDisposition(null, 'files.zip')).toBe('files.zip');
    expect(filenameFromDisposition('attachment', 'files.zip')).toBe('files.zip');
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%zz`, 'files.zip')).toBe(
      'files.zip',
    );
  });
});

describe('fallbackName', () => {
  it('uses the last path segment for a plain path', () => {
    expect(fallbackName('/home/user/notes/report.md')).toBe('report.md');
  });

  it('names glob downloads files.zip', () => {
    expect(fallbackName('/home/user/notes/*.md')).toBe('files.zip');
  });

  it('never returns empty', () => {
    expect(fallbackName('/')).toBe('download');
  });
});
