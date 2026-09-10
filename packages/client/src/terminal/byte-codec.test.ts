import { describe, expect, it, vi } from 'vitest';
import { isLatin1, latin1Decode, latin1Encode, writeMixed } from './byte-codec';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('latin1 round-trip', () => {
  it('preserves every possible byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(latin1Encode(latin1Decode(all))).toEqual(all);
  });

  it('keeps a UTF-8 sequence intact as its individual bytes', () => {
    // "é" is 0xC3 0xA9 — it must survive as TWO bytes, not one code point.
    const utf8 = bytes(0xc3, 0xa9);
    const text = latin1Decode(utf8);
    expect(text).toHaveLength(2);
    expect(latin1Encode(text)).toEqual(utf8);
  });

  it('handles a frame larger than the fromCharCode chunk size', () => {
    const big = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 256);
    expect(latin1Encode(latin1Decode(big))).toEqual(big);
  });
});

describe('isLatin1', () => {
  it('accepts byte-domain text and rejects real unicode', () => {
    expect(isLatin1(latin1Decode(bytes(0x00, 0x7f, 0xff)))).toBe(true);
    expect(isLatin1('progress █ 50%')).toBe(false);
  });
});

describe('writeMixed', () => {
  it('writes pass-through data as exact bytes', () => {
    const write = vi.fn();
    writeMixed(write, latin1Decode(bytes(0x1b, 0x5b, 0x41, 0xc3, 0xa9)));
    expect(write).toHaveBeenCalledWith(bytes(0x1b, 0x5b, 0x41, 0xc3, 0xa9));
  });

  it('writes middleware-generated text as a string so it renders', () => {
    const write = vi.fn();
    writeMixed(write, 'trzsz ██████ 42%');
    expect(write).toHaveBeenCalledWith('trzsz ██████ 42%');
  });
});
