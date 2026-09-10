import { describe, it, expect } from 'vitest';
import { URL_RE, findRegexLinkInRow, isSafeUrl, normalizeUrl, createOsc8Tracker } from './links';

describe('URL_RE', () => {
  it('matches http, https and bare www.', () => {
    expect('http://a.com'.match(URL_RE)?.[0]).toBe('http://a.com');
    expect('https://a.com'.match(URL_RE)?.[0]).toBe('https://a.com');
    expect('www.a.com'.match(URL_RE)?.[0]).toBe('www.a.com');
  });
});

describe('findRegexLinkInRow', () => {
  it('hits at the first, middle and last char of the match', () => {
    const row = 'go to https://a.com now';
    // "https://a.com" spans columns 6..19 (exclusive)
    expect(findRegexLinkInRow(row, 6)).toBe('https://a.com');
    expect(findRegexLinkInRow(row, 12)).toBe('https://a.com');
    expect(findRegexLinkInRow(row, 18)).toBe('https://a.com');
  });

  it('misses one column past the end of the match', () => {
    const row = 'go to https://a.com now';
    expect(findRegexLinkInRow(row, 19)).toBeNull();
  });

  it('trims trailing sentence punctuation and excludes it from the span', () => {
    const row = 'see https://a.com.';
    expect(findRegexLinkInRow(row, 4)).toBe('https://a.com');
    // the trailing '.' at column 17 is trimmed off, so it must not match
    expect(findRegexLinkInRow(row, 17)).toBeNull();
  });

  it('keeps a trailing ) when the match contains a matching (', () => {
    const row = 'see https://en.wikipedia.org/wiki/Foo_(bar) now';
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(findRegexLinkInRow(row, 4)).toBe(url);
    // last char ')' is part of the URL, so a col landing on it still matches
    expect(findRegexLinkInRow(row, row.indexOf(url) + url.length - 1)).toBe(url);
  });

  it('trims a trailing ) when the match has no matching (', () => {
    const row = '(see https://x.com)';
    expect(findRegexLinkInRow(row, 5)).toBe('https://x.com');
    // the trailing ')' is trimmed off, so it must not match
    expect(findRegexLinkInRow(row, row.length - 1)).toBeNull();
  });

  it('picks the right URL among two in one row', () => {
    const row = 'https://a.com and https://b.com';
    const bStart = row.indexOf('https://b.com');
    expect(findRegexLinkInRow(row, 0)).toBe('https://a.com');
    expect(findRegexLinkInRow(row, bStart)).toBe('https://b.com');
    expect(findRegexLinkInRow(row, bStart + 5)).toBe('https://b.com');
  });
});

describe('isSafeUrl', () => {
  it('accepts http, https and mailto', () => {
    expect(isSafeUrl('http://a.com')).toBe(true);
    expect(isSafeUrl('https://a.com')).toBe(true);
    expect(isSafeUrl('mailto:a@b.com')).toBe(true);
  });

  it('rejects unsafe or unparseable schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,hi')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('not a url')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('adds https:// to a bare www. match', () => {
    expect(normalizeUrl('www.a.com')).toBe('https://www.a.com');
  });

  it('leaves an already-schemed URL untouched', () => {
    expect(normalizeUrl('https://a.com')).toBe('https://a.com');
  });
});

describe('createOsc8Tracker', () => {
  it('contains a cell within a single-row range', () => {
    const t = createOsc8Tracker();
    t.begin('https://a.com', 5, 10);
    t.end(15, 10);
    expect(t.at(5, 10)).toBe('https://a.com');
    expect(t.at(10, 10)).toBe('https://a.com');
    expect(t.at(14, 10)).toBe('https://a.com');
  });

  it('contains a cell on a middle row of a multi-row range', () => {
    const t = createOsc8Tracker();
    t.begin('https://a.com', 5, 10);
    t.end(3, 12);
    expect(t.at(0, 11)).toBe('https://a.com');
    expect(t.at(50, 11)).toBe('https://a.com');
  });

  it('excludes a cell before the start or at/after the end', () => {
    const t = createOsc8Tracker();
    t.begin('https://a.com', 5, 10);
    t.end(15, 10);
    expect(t.at(4, 10)).toBeNull();
    expect(t.at(0, 9)).toBeNull();
    expect(t.at(15, 10)).toBeNull(); // end is exclusive
    expect(t.at(0, 11)).toBeNull();
  });

  it('implicitly closes an open link when begin() is called again', () => {
    const t = createOsc8Tracker();
    t.begin('https://a.com', 0, 0);
    t.begin('https://b.com', 10, 0);
    t.end(20, 0);
    expect(t.at(0, 0)).toBe('https://a.com');
    expect(t.at(9, 0)).toBe('https://a.com');
    expect(t.at(10, 0)).toBe('https://b.com');
    expect(t.at(19, 0)).toBe('https://b.com');
    expect(t.ranges().length).toBe(2);
  });

  it('is a no-op when end() is called with nothing open', () => {
    const t = createOsc8Tracker();
    t.end(5, 5);
    expect(t.ranges().length).toBe(0);
    expect(t.at(5, 5)).toBeNull();
  });

  it('evicts from the front once the ring exceeds max', () => {
    const t = createOsc8Tracker(3);
    for (let i = 0; i < 5; i++) {
      t.begin(`https://${i}.com`, i, 0);
      t.end(i + 1, 0);
    }
    const ranges = t.ranges();
    expect(ranges.length).toBe(3);
    expect(ranges.map((r) => r.url)).toEqual(['https://2.com', 'https://3.com', 'https://4.com']);
    // the evicted early ranges are gone
    expect(t.at(0, 0)).toBeNull();
    expect(t.at(2, 0)).toBe('https://2.com');
  });

  it('clear() drops all ranges and any open link', () => {
    const t = createOsc8Tracker();
    t.begin('https://a.com', 0, 0);
    t.clear();
    t.end(5, 0);
    expect(t.ranges().length).toBe(0);
  });
});

// ── clear(), and why it has to be called ──────────────────────────────────────
//
// Ranges are keyed by ABSOLUTE buffer cell. `Terminal.reset()` — which is what a
// tab switch does — restarts those coordinates at zero, so a range that survives
// a reset points at whatever the NEXT session draws in the same cells: a link
// from another shell attached to unrelated text, with nothing on screen to say
// so. `clear()` existed for exactly this and had no callers; TerminalPane now
// calls it alongside every reset.
describe('Osc8Tracker.clear', () => {
  it('forgets closed ranges', () => {
    const t = createOsc8Tracker();
    t.begin('https://a.com', 0, 5);
    t.end(10, 5);
    expect(t.at(3, 5)).toBe('https://a.com');
    t.clear();
    expect(t.at(3, 5)).toBeNull();
    expect(t.ranges()).toHaveLength(0);
  });

  // The dangerous one: a link left OPEN across the reset would otherwise be
  // closed by the next session's first end() and swallow a whole screen.
  it('drops the link that is still open', () => {
    const t = createOsc8Tracker();
    t.begin('https://a.com', 0, 5);
    t.clear();
    t.end(80, 40);
    expect(t.ranges()).toHaveLength(0);
    expect(t.at(0, 5)).toBeNull();
    expect(t.at(10, 20)).toBeNull();
  });

  it('leaves the tracker usable afterwards', () => {
    const t = createOsc8Tracker();
    t.begin('https://a.com', 0, 0);
    t.end(5, 0);
    t.clear();
    t.begin('https://b.com', 0, 0);
    t.end(5, 0);
    expect(t.at(2, 0)).toBe('https://b.com');
  });
});
