// The ways to pick lines for a comment, from `review-comments` ("A comment attaches
// to a line or a range on one side"): a drag and shift-click on desktop, tap then
// tap on a phone.

import { describe, expect, it } from 'vitest';
import {
  beginSelection,
  extendSelection,
  pickSelection,
  rangeOf,
  releaseSelection,
  tapSelection,
  type LineSelection,
  type LineTarget,
} from './line-selection';

const at = (no: number, over: Partial<LineTarget> = {}): LineTarget => ({
  path: 'a.ts',
  side: 'new',
  no,
  ...over,
});

describe('a mouse drag', () => {
  it('runs from where it began to where it is, in either direction', () => {
    let sel: LineSelection | null = beginSelection(null, at(14), false);
    sel = extendSelection(sel, at(10));
    sel = extendSelection(sel, at(12));
    expect(sel).toMatchObject({ anchor: 14, end: 12, phase: 'drag' });
    expect(rangeOf(sel!)).toEqual({ path: 'a.ts', side: 'new', start: 12, end: 14 });
    sel = releaseSelection(sel);
    expect(sel?.phase).toBe('range');
  });

  it('stays on the side and the file it began on', () => {
    const sel = beginSelection(null, at(5), false);
    expect(extendSelection(sel, at(9, { side: 'old' }))).toBe(sel);
    expect(extendSelection(sel, at(9, { path: 'b.ts' }))).toBe(sel);
  });

  it('is not extended once released', () => {
    const sel = releaseSelection(beginSelection(null, at(5), false));
    expect(extendSelection(sel, at(9))).toBe(sel);
  });

  it('is a one-line pick when the mouse never moved', () => {
    const sel = releaseSelection(beginSelection(null, at(42), false));
    expect(rangeOf(sel!)).toMatchObject({ start: 42, end: 42 });
  });
});

describe('shift-click', () => {
  it('extends the range already picked, keeping where it began', () => {
    const first = releaseSelection(beginSelection(null, at(10), false));
    const sel = releaseSelection(beginSelection(first, at(14), true));
    expect(rangeOf(sel!)).toMatchObject({ start: 10, end: 14 });
    // And again, the other way round.
    const back = releaseSelection(beginSelection(sel, at(7), true));
    expect(rangeOf(back!)).toMatchObject({ start: 7, end: 10 });
  });

  it('starts a new pick when there is none on this side of this file', () => {
    const first = releaseSelection(beginSelection(null, at(10), false));
    expect(rangeOf(beginSelection(first, at(14, { side: 'old' }), true))).toMatchObject({
      side: 'old',
      start: 14,
      end: 14,
    });
    expect(rangeOf(beginSelection(null, at(3), true))).toMatchObject({ start: 3, end: 3 });
  });

  it('is a plain click without shift: a new pick', () => {
    const first = releaseSelection(beginSelection(null, at(10), false));
    expect(rangeOf(beginSelection(first, at(14), false))).toMatchObject({ start: 14, end: 14 });
  });
});

describe('tap then tap, on a phone', () => {
  it('picks the line at the first tap and widens to the second', () => {
    const one = tapSelection(null, at(10));
    expect(one).toMatchObject({ phase: 'start' });
    expect(rangeOf(one)).toMatchObject({ start: 10, end: 10 });
    const range = tapSelection(one, at(14));
    expect(range.phase).toBe('range');
    expect(rangeOf(range)).toEqual({ path: 'a.ts', side: 'new', start: 10, end: 14 });
  });

  it('starts again at a third tap', () => {
    const range = tapSelection(tapSelection(null, at(10)), at(14));
    const again = tapSelection(range, at(30));
    expect(again.phase).toBe('start');
    expect(rangeOf(again)).toMatchObject({ start: 30, end: 30 });
  });

  it('starts again when the second tap is on another side or file', () => {
    const one = tapSelection(null, at(10));
    expect(rangeOf(tapSelection(one, at(14, { side: 'old' })))).toMatchObject({
      side: 'old',
      start: 14,
      end: 14,
    });
    expect(rangeOf(tapSelection(one, at(14, { path: 'b.ts' })))).toMatchObject({
      path: 'b.ts',
      start: 14,
    });
  });

  it('lets a second tap on the same line make it a settled one-line range', () => {
    const range = tapSelection(tapSelection(null, at(10)), at(10));
    expect(range.phase).toBe('range');
    expect(rangeOf(range)).toMatchObject({ start: 10, end: 10 });
  });
});

describe('a key', () => {
  it('picks one line as a settled range, with no drag to wait for', () => {
    const sel = pickSelection(null, at(42), false);
    expect(sel).toEqual({ path: 'a.ts', side: 'new', anchor: 42, end: 42, phase: 'range' });
    expect(rangeOf(sel)).toEqual({ path: 'a.ts', side: 'new', start: 42, end: 42 });
  });

  it('with shift widens the range already picked, from where it began, either way round', () => {
    let sel = pickSelection(null, at(40), false);
    sel = pickSelection(sel, at(44), true);
    expect(rangeOf(sel)).toMatchObject({ start: 40, end: 44 });
    sel = pickSelection(sel, at(37), true);
    expect(sel).toMatchObject({ anchor: 40, end: 37, phase: 'range' });
    expect(rangeOf(sel)).toMatchObject({ start: 37, end: 40 });
  });

  it('without shift starts again on the number it is on', () => {
    let sel = pickSelection(null, at(40), false);
    sel = pickSelection(sel, at(44), false);
    expect(sel).toMatchObject({ anchor: 44, end: 44, phase: 'range' });
  });

  it('never carries a range across a side or a file, even with shift', () => {
    const picked = pickSelection(null, at(40), false);
    expect(pickSelection(picked, at(44, { side: 'old' }), true)).toMatchObject({
      side: 'old',
      anchor: 44,
      end: 44,
    });
    expect(pickSelection(picked, at(44, { path: 'b.ts' }), true)).toMatchObject({
      path: 'b.ts',
      anchor: 44,
    });
  });

  it('shift with nothing picked is a plain pick', () => {
    expect(pickSelection(null, at(9), true)).toMatchObject({ anchor: 9, end: 9, phase: 'range' });
  });
});
