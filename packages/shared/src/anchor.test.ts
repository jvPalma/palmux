import { describe, expect, it } from 'vitest';
import {
  anchorLines,
  relocateLine,
  specAt,
  splitLines,
  type AnchorResult,
  type AnchorSpec,
} from './anchor';

const lines = (text: string): string[] => splitLines(text);

/** A stored anchor for the 1-based range `start..end` of `source`, with `context` lines around it. */
function store(source: readonly string[], start: number, end = start, context = 3): AnchorSpec {
  return {
    lines: source.slice(start - 1, end),
    before: source.slice(Math.max(0, start - 1 - context), start - 1),
    after: source.slice(end, end + context),
    start,
  };
}

const at = (result: AnchorResult): number | 'outdated' =>
  result.outdated ? 'outdated' : result.start;

describe('splitLines', () => {
  it('drops the phantom line a trailing newline makes', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });

  it('keeps real blank lines, including a final one', () => {
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('\n')).toEqual(['']);
  });

  it('answers no lines for no text', () => {
    expect(splitLines('')).toEqual([]);
  });
});

describe('anchorLines', () => {
  const file = lines(
    [
      'import a',
      'import b',
      '',
      'function f() {',
      '  one();',
      '  two();',
      '}',
      '',
      'export {};',
    ].join('\n'),
  );

  it('keeps the position of unchanged code', () => {
    expect(at(anchorLines(file, store(file, 5)))).toBe(5);
  });

  // "Lines inserted above": the comment sits on line 50, ten lines go in at line 5.
  it('follows code that moved down when lines were inserted above it', () => {
    const inserted = [
      ...file.slice(0, 2),
      ...Array.from({ length: 10 }, (_, i) => `new ${i}`),
      ...file.slice(2),
    ];
    expect(at(anchorLines(inserted, store(file, 5)))).toBe(15);
    expect(at(anchorLines(inserted, store(file, 5, 6)))).toBe(15);
  });

  it('follows code that moved up when lines were deleted above it', () => {
    const deleted = file.slice(2);
    expect(at(anchorLines(deleted, store(file, 5)))).toBe(3);
  });

  it('reports the end of a multi-line range', () => {
    const result = anchorLines(file, store(file, 5, 6));
    expect(result).toEqual({ outdated: false, start: 5, end: 6, score: 6 });
  });

  it('is outdated when the code is gone', () => {
    const without = file.filter((line) => !line.includes('one'));
    expect(at(anchorLines(without, store(file, 5)))).toBe('outdated');
  });

  it('is outdated when only part of a range survives', () => {
    const edited = file.map((line) => (line === '  two();' ? '  three();' : line));
    expect(at(anchorLines(edited, store(file, 5, 6)))).toBe('outdated');
  });

  it('is outdated for an empty anchor', () => {
    expect(at(anchorLines(file, { lines: [], before: [], after: [], start: 1 }))).toBe('outdated');
  });

  it('matches whitespace exactly', () => {
    const reindented = file.map((line) => (line === '  one();' ? '    one();' : line));
    expect(at(anchorLines(reindented, store(file, 5)))).toBe('outdated');
  });

  // The old position gets no head start. A `}` left at its old number must lose to
  // the `}` that kept its context ten rows down.
  describe('repeated lines', () => {
    const before = lines(
      ['if (a) {', '  x();', '}', 'if (b) {', '  y();', '}', 'if (c) {', '  z();', '}'].join('\n'),
    );

    it('moves a closing brace with its context, not by its number', () => {
      // Comment on the `}` of `if (c)`, line 9. Ten lines go in at the top, so the
      // old number 9 now holds a different line, and 19 holds the commented brace.
      const padded = [...Array.from({ length: 10 }, (_, i) => `// pad ${i}`), ...before];
      expect(padded[8]).toBe('// pad 8');
      expect(at(anchorLines(padded, store(before, 9)))).toBe(19);
    });

    it('does not accept a brace left at the old number when its context changed', () => {
      // Insert a whole new block before the commented one: line 9 is still a `}`,
      // now of `if (b)`, and the commented brace is three lines further down.
      const grown = [...before.slice(0, 6), 'if (new) {', '  w();', '}', ...before.slice(6)];
      expect(grown[8]).toBe('}');
      expect(at(anchorLines(grown, store(before, 9)))).toBe(12);
    });

    it('moves a blank line with its context', () => {
      const source = lines(['a', 'b', 'c', '', 'd', 'e', 'f', '', 'g', 'h', 'i'].join('\n'));
      // The blank line between f and g, line 8; two lines go in above.
      const moved = ['x', 'y', ...source];
      expect(at(anchorLines(moved, store(source, 8)))).toBe(10);
    });

    it('prefers the candidate nearer the old position when the context is equal', () => {
      // No context on either side of the stored line, so only distance can decide,
      // and the old position wins here on distance alone, like any other candidate.
      const spec: AnchorSpec = { lines: ['a'], before: [], after: [], start: 4 };
      expect(at(anchorLines(['a', 'a', 'a', 'a', 'a'], spec))).toBe(4);
      const biased: AnchorSpec = { lines: ['a'], before: [], after: [], start: 1 };
      expect(at(anchorLines(['a', 'b', 'c', 'a'], biased))).toBe(1);
    });

    it('is outdated when the equal candidates sit on either side of the old position', () => {
      const spec: AnchorSpec = { lines: ['a'], before: [], after: [], start: 2 };
      expect(at(anchorLines(['a', 'b', 'a'], spec))).toBe('outdated');
    });
  });

  describe('ties', () => {
    it('is outdated rather than a guess when two candidates score and sit alike', () => {
      const source = ['x', 'dup', 'x', 'dup', 'x'];
      // Stored at line 3 (between the two); both `dup` lines are 1 away with equal context.
      const spec: AnchorSpec = { lines: ['dup'], before: ['x'], after: ['x'], start: 3 };
      expect(at(anchorLines(source, spec))).toBe('outdated');
    });

    it('lets context break a tie that distance would not', () => {
      const source = ['p', 'dup', 'q', 'dup', 'r'];
      const spec: AnchorSpec = { lines: ['dup'], before: ['q'], after: ['r'], start: 3 };
      expect(at(anchorLines(source, spec))).toBe(4);
    });

    it('lets distance break a tie in context', () => {
      const source = ['dup', 'm', 'm', 'm', 'dup'];
      const spec: AnchorSpec = { lines: ['dup'], before: [], after: [], start: 4 };
      expect(at(anchorLines(source, spec))).toBe(5);
    });

    it('is not tied by a candidate that scores lower', () => {
      const source = ['q', 'dup', 'r', 'z', 'dup', 'z'];
      const spec: AnchorSpec = { lines: ['dup'], before: ['q'], after: ['r'], start: 5 };
      expect(at(anchorLines(source, spec))).toBe(2);
    });

    it('accepts a unique match even with none of its context left', () => {
      const source = ['unrelated', 'only here', 'also unrelated'];
      const spec: AnchorSpec = {
        lines: ['only here'],
        before: ['gone'],
        after: ['gone too'],
        start: 40,
      };
      expect(anchorLines(source, spec)).toEqual({ outdated: false, start: 2, end: 2, score: 0 });
    });
  });

  it('scores context at the first lines of a file, where `before` is short', () => {
    const source = ['top', 'next', 'more'];
    expect(at(anchorLines(source, store(source, 1)))).toBe(1);
  });
});

describe('specAt', () => {
  const source = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('builds three lines of context either side', () => {
    expect(specAt(source, 4)).toEqual({
      lines: ['d'],
      before: ['a', 'b', 'c'],
      after: ['e', 'f', 'g'],
      start: 4,
    });
  });

  it('shortens the context at either end', () => {
    expect(specAt(source, 1)).toMatchObject({ before: [], after: ['b', 'c', 'd'] });
    expect(specAt(source, 7)).toMatchObject({ before: ['d', 'e', 'f'], after: [] });
  });

  it('is null for a line that does not exist', () => {
    expect(specAt(source, 0)).toBeNull();
    expect(specAt(source, 8)).toBeNull();
  });
});

describe('relocateLine', () => {
  const oldText =
    ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n') + '\n';

  it('finds a line again after lines were inserted above it', () => {
    const newText = ['zero a', 'zero b', ...oldText.split('\n')].join('\n');
    expect(relocateLine(oldText, newText, 5)).toEqual({ line: 7, exact: true });
  });

  it('keeps the number of an unchanged line', () => {
    expect(relocateLine(oldText, oldText, 4)).toEqual({ line: 4, exact: true });
  });

  it('does not mistake a repeated line for the old position', () => {
    const old = ['a', 'b', '}', 'c', 'd', '}', 'e', 'f'];
    // Four lines go in at the top; the `}` that was line 6 is now line 10.
    const next = ['p', 'q', 'r', 's', ...old];
    expect(relocateLine(old, next, 6)).toEqual({ line: 10, exact: true });
  });

  it('takes the nearest surviving line when the line itself was deleted', () => {
    const next = oldText
      .split('\n')
      .filter((l) => l !== 'four')
      .join('\n');
    const result = relocateLine(oldText, next, 4);
    expect(result).toEqual({ line: 3, exact: false });
  });

  it('prefers the neighbour above when both sides survive equally', () => {
    const next = oldText
      .split('\n')
      .filter((l) => l !== 'four')
      .join('\n');
    expect(relocateLine(oldText, next, 4)?.line).toBe(3);
  });

  it('falls to the neighbour below when the one above is gone too', () => {
    const next = oldText
      .split('\n')
      .filter((l) => l !== 'three' && l !== 'four')
      .join('\n');
    expect(relocateLine(oldText, next, 4)).toEqual({ line: 3, exact: false });
  });

  it('stays inside the hunk it was given', () => {
    // Lines 3-4 are the hunk and both were deleted; 2 and 5 survive but lie outside it.
    const next = oldText
      .split('\n')
      .filter((l) => l !== 'three' && l !== 'four')
      .join('\n');
    expect(relocateLine(oldText, next, 4, { within: { from: 3, to: 4 } })).toBeNull();
  });

  it('is null when nothing near the line survives', () => {
    expect(relocateLine(oldText, 'completely\ndifferent\n', 4)).toBeNull();
  });

  it('is null for a line outside the old text', () => {
    expect(relocateLine(oldText, oldText, 0)).toBeNull();
    expect(relocateLine(oldText, oldText, 99)).toBeNull();
  });

  it('accepts lines as well as text', () => {
    const oldLines = oldText.split('\n').slice(0, -1);
    expect(relocateLine(oldLines, ['x', ...oldLines], 2)).toEqual({ line: 3, exact: true });
  });

  it('honours a smaller context', () => {
    const old = ['a', 'b', 'c', 'd'];
    // With one context line each side, `c` matches in a file where its neighbours changed further out.
    const next = ['A', 'B', 'b', 'c', 'd', 'D'];
    expect(relocateLine(old, next, 3, { context: 1 })).toEqual({ line: 4, exact: true });
  });
});
