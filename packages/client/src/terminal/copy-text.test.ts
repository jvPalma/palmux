import { describe, expect, it } from 'vitest';
import { stripTrailingSpaces } from './copy-text';

describe('stripTrailingSpaces', () => {
  it('strips full-width padding from every line', () => {
    const padded = 'something something          \nsomething                    ';
    expect(stripTrailingSpaces(padded)).toBe('something something\nsomething');
  });

  it('preserves leading indentation', () => {
    expect(stripTrailingSpaces('  indented code   \n    deeper   ')).toBe(
      '  indented code\n    deeper',
    );
  });

  it('collapses whitespace-only lines to empty lines', () => {
    expect(stripTrailingSpaces('a   \n      \nb')).toBe('a\n\nb');
  });

  it('strips trailing tabs too', () => {
    expect(stripTrailingSpaces('cmd\t\t')).toBe('cmd');
  });

  it('leaves clean text untouched', () => {
    expect(stripTrailingSpaces('one\ntwo\nthree')).toBe('one\ntwo\nthree');
  });

  it('handles single-line and empty input', () => {
    expect(stripTrailingSpaces('word   ')).toBe('word');
    expect(stripTrailingSpaces('')).toBe('');
  });
});
