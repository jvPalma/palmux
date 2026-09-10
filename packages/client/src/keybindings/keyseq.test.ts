import { describe, it, expect } from 'vitest';
import { encodeKeySeq } from './keyseq';

const codes = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

describe('encodeKeySeq', () => {
  it('parses ^X control bytes', () => {
    expect(codes(encodeKeySeq('^A'))).toEqual([0x01]);
    expect(codes(encodeKeySeq('^Z'))).toEqual([0x1a]);
    expect(codes(encodeKeySeq('^_'))).toEqual([0x1f]);
    expect(codes(encodeKeySeq('^['))).toEqual([0x1b]);
  });

  it('parses \\xNN hex escapes', () => {
    expect(codes(encodeKeySeq('\\x1b'))).toEqual([0x1b]);
    expect(codes(encodeKeySeq('\\x00'))).toEqual([0x00]);
    expect(codes(encodeKeySeq('a\\x41b'))).toEqual([0x61, 0x41, 0x62]);
  });

  it('parses \\e \\n \\r \\t and \\\\', () => {
    expect(codes(encodeKeySeq('\\e'))).toEqual([0x1b]);
    expect(encodeKeySeq('\\n')).toBe('\n');
    expect(encodeKeySeq('\\r')).toBe('\r');
    expect(encodeKeySeq('\\t')).toBe('\t');
    expect(encodeKeySeq('\\\\')).toBe('\\');
  });

  it('passes literals through and combines forms', () => {
    expect(encodeKeySeq('hi')).toBe('hi');
    expect(codes(encodeKeySeq('\\e[Z'))).toEqual([0x1b, 0x5b, 0x5a]); // ESC [ Z (backtab)
  });

  it('is lenient on malformed escapes', () => {
    expect(encodeKeySeq('\\xZZ')).toBe('xZZ'); // bad hex → literal
    expect(encodeKeySeq('\\q')).toBe('q'); // unknown escape → literal char
    expect(encodeKeySeq('^')).toBe('^'); // trailing ^ → literal
  });
});
