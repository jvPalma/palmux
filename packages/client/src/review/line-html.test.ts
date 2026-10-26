// A line drawn plain and the same line drawn coloured must lay out identically, and
// the inner marks must land on the characters that differ in either shape. Monaco's
// markup is built here the way `colorize` writes it: one span per token, spaces as
// `&#160;`, tabs expanded to 4-column stops.

import { describe, expect, it } from 'vitest';
import { innerDiff } from './inner-diff';
import {
  displayText,
  expandTabs,
  markColored,
  normalizeColored,
  plainSegments,
  toVisualRanges,
  visualLength,
} from './line-html';

describe('expandTabs', () => {
  it('leaves a line without tabs alone and maps each character to itself', () => {
    const { text, map } = expandTabs('const a = 1;');
    expect(text).toBe('const a = 1;');
    expect(map[0]).toBe(0);
    expect(map[12]).toBe(12);
    expect(map).toHaveLength(13);
  });

  it('expands a tab to the next 4-column stop', () => {
    expect(expandTabs('\tx').text).toBe('    x');
    expect(expandTabs('ab\tx').text).toBe('ab  x');
    expect(expandTabs('abcd\tx').text).toBe('abcd    x');
  });

  it('maps source offsets through the expansion', () => {
    const { text, map } = expandTabs('a\tb');
    expect(text).toBe('a   b');
    expect(map).toEqual([0, 1, 4, 5]);
  });

  it('measures the expanded width without building it', () => {
    for (const line of ['', 'abc', '\t', 'a\tb\tc', '\t\t x']) {
      expect(visualLength(line), JSON.stringify(line)).toBe(expandTabs(line).text.length);
    }
  });
});

describe('displayText', () => {
  it('drops carriage returns, as the colouring does', () => {
    expect(displayText('a\r')).toBe('a');
    expect(displayText('a\r\nb')).toBe('a\nb');
  });
});

describe('toVisualRanges', () => {
  it('moves a range past an expanded tab and drops an empty one', () => {
    const { map } = expandTabs('\tfoo bar');
    expect(
      toVisualRanges(map, [
        { start: 1, end: 4 },
        { start: 5, end: 5 },
      ]),
    ).toEqual([{ start: 4, end: 7 }]);
  });
});

describe('plainSegments', () => {
  it('cuts the text at the range edges', () => {
    expect(plainSegments('const total = 1', [{ start: 6, end: 11 }])).toEqual([
      { text: 'const ', marked: false, start: 0 },
      { text: 'total', marked: true, start: 6 },
      { text: ' = 1', marked: false, start: 11 },
    ]);
  });

  it('is one unmarked segment with no ranges, and none for empty text', () => {
    expect(plainSegments('abc', [])).toEqual([{ text: 'abc', marked: false, start: 0 }]);
    expect(plainSegments('', [])).toEqual([]);
  });
});

describe('normalizeColored', () => {
  it('turns Monaco’s non-breaking spaces back into spaces', () => {
    expect(normalizeColored('<span class="mtk1">a&#160;b</span>')).toBe(
      '<span class="mtk1">a b</span>',
    );
  });
});

/** Monaco's markup for `parts` (class, text) in order, text already in its escaped form. */
const markup = (...parts: [string, string][]): string =>
  parts.map(([cls, text]) => `<span class="${cls}">${text}</span>`).join('');

describe('markColored', () => {
  it('returns the markup untouched with nothing to mark', () => {
    const html = markup(['mtk1', 'abc']);
    expect(markColored(html, 'abc', [])).toBe(html);
  });

  it('wraps the marked characters inside the span that holds them', () => {
    const html = markup(['mtk6', 'const'], ['mtk1', ' total = 1']);
    const out = markColored(html, 'const total = 1', [{ start: 6, end: 11 }]);
    expect(out).toBe(
      '<span class="mtk6">const</span><span class="mtk1"> <span class="rv-mark">total</span> = 1</span>',
    );
  });

  it('closes a mark at a colour boundary and opens another after it', () => {
    const html = markup(['mtk6', 'const'], ['mtk1', ' total']);
    // `st to` runs from the end of the keyword into the identifier.
    const out = markColored(html, 'const total', [{ start: 3, end: 8 }]);
    expect(out).toBe(
      '<span class="mtk6">con<span class="rv-mark">st</span></span>' +
        '<span class="mtk1"><span class="rv-mark"> to</span>tal</span>',
    );
  });

  it('counts an entity as one character and keeps it as written', () => {
    const html = markup(['mtk1', 'a &lt; b &amp;&amp; c']);
    const visual = 'a < b && c';
    const out = markColored(html, visual, [{ start: 2, end: 3 }]);
    expect(out).toBe(
      '<span class="mtk1">a <span class="rv-mark">&lt;</span> b &amp;&amp; c</span>',
    );
  });

  it('lands marks on the right characters after a tab', () => {
    const source = '\tfoo bar';
    const { text, map } = expandTabs(source);
    const html = markup(['mtk1', text.replaceAll(' ', '&#160;')]);
    const out = markColored(
      normalizeColored(html),
      text,
      toVisualRanges(map, [{ start: 5, end: 8 }]),
    );
    expect(out).toBe('<span class="mtk1">    foo <span class="rv-mark">bar</span></span>');
  });

  it('refuses to guess when the markup is not the line it claims to colour', () => {
    const html = markup(['mtk1', 'something else']);
    expect(markColored(html, 'const total', [{ start: 6, end: 11 }])).toBe(html);
  });

  it('refuses a stray angle bracket rather than splicing into it', () => {
    const html = '<span class="mtk1">a < b</span>';
    expect(markColored(html, 'a < b', [{ start: 0, end: 1 }])).toBe(html);
  });

  it('marks exactly what the inner diff reports for the renamed-variable case', () => {
    const oldLine = 'const total = a + b';
    const newLine = 'const sum = a + b';
    const diff = innerDiff(oldLine, newLine);
    expect(diff).not.toBeNull();
    const html = markup(['mtk6', 'const'], ['mtk1', ' sum = a + b']);
    const out = markColored(html, newLine, diff!.new);
    expect(out).toContain('<span class="rv-mark">sum</span>');
    expect(out.match(/rv-mark/g)).toHaveLength(1);
  });
});
