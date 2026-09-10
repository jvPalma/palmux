// What the theme swatch shows, as data. The point of the preview is COVERAGE of
// the palette — a swatch that only ever painted three slots would look fine and
// tell you nothing about the other thirteen.

import { describe, expect, it } from 'vitest';
import {
  groupByBrightness,
  MAX_PREVIEW_CHARS,
  PREVIEW_LINES,
  previewSlots,
} from './theme-preview';

describe('PREVIEW_LINES', () => {
  it('paints the colours a terminal actually shows you all day', () => {
    // 1–6 and 9–14 are the six hues in both normal and bright, plus 8 for the
    // comment grey every theme has and every theme can get wrong.
    expect(previewSlots()).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]);
  });

  // 0 and 7/15 are the background and the foreground; the swatch shows those by
  // BEING them, so spending a token on either would be a wasted line.
  it('leaves the background and foreground slots to the swatch itself', () => {
    expect(previewSlots()).not.toContain(0);
    expect(previewSlots()).not.toContain(7);
    expect(previewSlots()).not.toContain(15);
  });

  it('is two lines and every token has text', () => {
    expect(PREVIEW_LINES).toHaveLength(2);
    for (const line of PREVIEW_LINES) {
      expect(line.length).toBeGreaterThan(3);
      for (const t of line) expect(t.text.length).toBeGreaterThan(0);
    }
  });

  // An ellipsis in a COLOUR sample silently hides the last slots it exists to
  // show, so the lines have to fit the 260px popup rather than merely survive it.
  it('keeps each line inside the swatch without truncating', () => {
    for (const line of PREVIEW_LINES) {
      const chars = line.reduce((n, t) => n + t.text.length, 0);
      expect(chars, line.map((t) => t.text).join('')).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
    }
  });

  it('uses the foreground for the neutral runs, not a colour', () => {
    const fgRuns = PREVIEW_LINES.flat().filter((t) => t.slot === 'fg');
    expect(fgRuns.length).toBeGreaterThan(0);
  });
});

describe('groupByBrightness', () => {
  const items = [
    { id: 'a', light: false },
    { id: 'b', light: true },
    { id: 'c', light: false },
    { id: 'd', light: true },
  ];

  it('splits without reordering inside a group', () => {
    const { dark, light } = groupByBrightness(items, (p) => p.light);
    expect(dark.map((p) => p.id)).toEqual(['a', 'c']);
    expect(light.map((p) => p.id)).toEqual(['b', 'd']);
  });

  // The registry's order is deliberate — sorting would scatter each family's
  // variants (Mocha, Macchiato, Frappé) across the list.
  it('preserves registry order exactly', () => {
    const rev = [...items].reverse();
    expect(groupByBrightness(rev, (p) => p.light).dark.map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('handles a group being empty', () => {
    expect(groupByBrightness(items, () => false).light).toEqual([]);
    expect(groupByBrightness([], () => true)).toEqual({ dark: [], light: [] });
  });
});
