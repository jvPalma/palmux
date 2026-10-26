import { describe, expect, it } from 'vitest';
import {
  innerDiff,
  MAX_INNER_CELLS,
  MAX_INNER_LINE_CHARS,
  type InnerDiff,
  type TextRange,
} from './inner-diff';

const slices = (line: string, ranges: readonly TextRange[]): string[] =>
  ranges.map((r) => line.slice(r.start, r.end));

function marked(oldLine: string, newLine: string): { old: string[]; new: string[] } {
  const diff = innerDiff(oldLine, newLine) as InnerDiff;
  expect(diff).not.toBeNull();
  return { old: slices(oldLine, diff.old), new: slices(newLine, diff.new) };
}

describe('innerDiff', () => {
  // The spec scenario: only `total` and `sum` carry the inner change mark.
  it('marks only the renamed variable', () => {
    const oldLine = 'const total = a + b';
    const newLine = 'const sum = a + b';
    const diff = innerDiff(oldLine, newLine);
    expect(diff).toEqual({ old: [{ start: 6, end: 11 }], new: [{ start: 6, end: 9 }] });
    expect(marked(oldLine, newLine)).toEqual({ old: ['total'], new: ['sum'] });
  });

  it('marks nothing for identical lines', () => {
    expect(innerDiff('same line', 'same line')).toEqual({ old: [], new: [] });
  });

  it('marks a pure insertion on the new side only', () => {
    expect(marked('call(a)', 'call(a, b)')).toEqual({ old: [], new: [', b'] });
  });

  it('marks a pure deletion on the old side only', () => {
    expect(marked('call(a, b)', 'call(a)')).toEqual({ old: [', b'], new: [] });
  });

  it('treats each punctuation character as its own token', () => {
    // `===` → `==` loses one `=` and does not mark the whole operator.
    expect(marked('if (a === b)', 'if (a == b)')).toEqual({ old: ['='], new: [] });
    expect(marked('foo.bar(x)', 'foo.baz(x)')).toEqual({ old: ['bar'], new: ['baz'] });
  });

  it('joins changed words that only whitespace separates', () => {
    expect(marked('return foo bar;', 'return baz qux;')).toEqual({
      old: ['foo bar'],
      new: ['baz qux'],
    });
  });

  it('keeps changes apart when something unchanged lies between them', () => {
    expect(marked('f(a, keep, b)', 'f(x, keep, y)')).toEqual({ old: ['a', 'b'], new: ['x', 'y'] });
  });

  it('marks a whitespace change', () => {
    expect(marked('a  b', 'a b')).toEqual({ old: ['  '], new: [' '] });
  });

  it('keeps offsets in UTF-16 units so a pane can slice with them', () => {
    const oldLine = 'título = 1';
    const newLine = 'título = 2';
    expect(marked(oldLine, newLine)).toEqual({ old: ['1'], new: ['2'] });
    expect(innerDiff('😀 x', '😀 y')).toEqual({
      old: [{ start: 3, end: 4 }],
      new: [{ start: 3, end: 4 }],
    });
  });

  it('marks everything when the lines share nothing', () => {
    expect(marked('abc', 'xyz')).toEqual({ old: ['abc'], new: ['xyz'] });
  });

  it('handles an empty side', () => {
    expect(marked('', 'added')).toEqual({ old: [], new: ['added'] });
    expect(marked('removed', '')).toEqual({ old: ['removed'], new: [] });
  });

  describe('bounds', () => {
    it('returns null for a line of 400 characters or more', () => {
      const long = 'x'.repeat(MAX_INNER_LINE_CHARS);
      expect(innerDiff(long, 'short')).toBeNull();
      expect(innerDiff('short', long)).toBeNull();
    });

    it('compares a line one character under the limit', () => {
      const old = `${'x'.repeat(MAX_INNER_LINE_CHARS - 2)}a`;
      const next = `${'x'.repeat(MAX_INNER_LINE_CHARS - 2)}b`;
      expect(innerDiff(old, next)).not.toBeNull();
    });

    it('returns null when the comparison would exceed the cell bound', () => {
      // Every token differs at both ends, so nothing is trimmed away. 60 words of
      // three characters stay under the character limit but make ~119 tokens a side.
      const old = Array.from({ length: 60 }, (_, i) => `a${i % 10}`).join(' ');
      const next = Array.from({ length: 60 }, (_, i) => `b${i % 10}`).join(' ');
      expect(old.length).toBeLessThan(MAX_INNER_LINE_CHARS);
      expect(innerDiff(old, next)).toBeNull();
    });

    it('allows exactly the cell bound and refuses one token over it', () => {
      // One punctuation character is one token: 100 x 100 = 10,000 cells.
      expect(MAX_INNER_CELLS).toBe(10_000);
      expect(innerDiff('('.repeat(100), '['.repeat(100))).not.toBeNull();
      expect(innerDiff('('.repeat(101), '['.repeat(100))).toBeNull();
    });

    it('measures the bound on what is left after trimming what both lines share', () => {
      // 90 shared words either side of one changed word: a one-cell comparison.
      const shared = Array.from({ length: 90 }, (_, i) => `w${i}`).join(' ');
      const old = `${shared} old ${shared}`.slice(0, MAX_INNER_LINE_CHARS - 1);
      const next = `${shared} new ${shared}`.slice(0, MAX_INNER_LINE_CHARS - 1);
      const diff = innerDiff(old, next);
      expect(diff).not.toBeNull();
      expect(slices(old, (diff as InnerDiff).old)).toEqual(['old']);
      expect(slices(next, (diff as InnerDiff).new)).toEqual(['new']);
    });
  });
});
