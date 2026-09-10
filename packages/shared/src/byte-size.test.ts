// The config size grammar. Everything here is about REFUSING rather than
// guessing: this value decides whether a request is rejected, so a typo read as
// a different magnitude is the failure the strictness exists to prevent.

import { describe, expect, it } from 'vitest';
import { formatByteSize, parseByteSize } from './byte-size';

describe('parseByteSize', () => {
  it('reads the three units, binary', () => {
    expect(parseByteSize('1KB')).toBe(1024);
    expect(parseByteSize('1MB')).toBe(1024 * 1024);
    expect(parseByteSize('1GB')).toBe(1024 * 1024 * 1024);
    expect(parseByteSize('50MB')).toBe(50 * 1024 * 1024);
  });

  it('tolerates case, whitespace and decimals', () => {
    expect(parseByteSize('1gb')).toBe(1024 ** 3);
    expect(parseByteSize('1 Gb')).toBe(1024 ** 3);
    expect(parseByteSize('  2mb  ')).toBe(2 * 1024 * 1024);
    expect(parseByteSize('1.5GB')).toBe(Math.floor(1.5 * 1024 ** 3));
  });

  it('still accepts a bare number of bytes, so old configs keep their meaning', () => {
    expect(parseByteSize(52428800)).toBe(52428800);
    expect(parseByteSize(1024.9)).toBe(1024);
  });

  // 0 is the documented "no limit" setting, in both the upload and the download
  // caps. Rejecting it would silently restore the default — the opposite.
  it('keeps zero, which means NO LIMIT', () => {
    expect(parseByteSize(0)).toBe(0);
    expect(parseByteSize('0KB')).toBe(0);
  });

  it('refuses everything outside the grammar rather than guessing', () => {
    for (const bad of [
      '1G', // no bare unit letters
      '1B',
      '1KiB',
      '1 gigabyte',
      'GB',
      '1GB extra',
      'x1GB',
      '',
      '   ',
      -1,
      NaN,
      Infinity,
      null,
      undefined,
      {},
      [],
      true,
    ]) {
      expect(parseByteSize(bad), JSON.stringify(bad) ?? String(bad)).toBeNull();
    }
  });
});

describe('formatByteSize', () => {
  it('renders in the same vocabulary the config accepts', () => {
    expect(formatByteSize(1024 ** 3)).toBe('1GB');
    expect(formatByteSize(50 * 1024 * 1024)).toBe('50MB');
    expect(formatByteSize(2048)).toBe('2KB');
    expect(formatByteSize(0)).toBe('0');
    expect(formatByteSize(512)).toBe('512');
  });

  it('round-trips whole units', () => {
    for (const s of ['1KB', '256MB', '2GB']) {
      expect(formatByteSize(parseByteSize(s)!)).toBe(s);
    }
  });

  it('shows two decimals for a non-integer scale rather than lying', () => {
    expect(formatByteSize(1536 * 1024 * 1024)).toBe('1.50GB');
  });
});
