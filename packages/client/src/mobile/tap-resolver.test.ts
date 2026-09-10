import { describe, expect, it } from 'vitest';

import { resolveTap, tapActionBytes, type TapContext } from './tap-resolver';

const base: TapContext = {
  mouseReporting: false,
  linkUrl: null,
  tapped: { col: 0, row: 0 },
  cursor: { col: 0, row: 0 },
  outputZone: null,
  promptRow: null,
};

describe('resolveTap', () => {
  it('forwards a mouse click when mouse reporting is on', () => {
    expect(resolveTap({ ...base, mouseReporting: true })).toEqual({ kind: 'mouse' });
  });

  it('mouse reporting wins over a link under the tap', () => {
    expect(resolveTap({ ...base, mouseReporting: true, linkUrl: 'https://example.com' })).toEqual({
      kind: 'mouse',
    });
  });

  it('opens a link under the tapped cell', () => {
    expect(resolveTap({ ...base, linkUrl: 'https://example.com' })).toEqual({
      kind: 'link',
      url: 'https://example.com',
    });
  });

  it('a link inside an active output zone still wins over the menu-row branch', () => {
    const ctx: TapContext = {
      ...base,
      linkUrl: 'https://example.com',
      outputZone: { start: 0, end: 5 },
      tapped: { col: 3, row: 2 },
      cursor: { col: 0, row: 0 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'link', url: 'https://example.com' });
  });

  it('walks the caret on a plain readline row', () => {
    const ctx: TapContext = {
      ...base,
      promptRow: 4,
      tapped: { col: 10, row: 4 },
      cursor: { col: 4, row: 4 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'caret', cols: 6 });
  });

  it('walks the caret left when tapped left of the cursor', () => {
    const ctx: TapContext = {
      ...base,
      promptRow: 4,
      tapped: { col: 1, row: 4 },
      cursor: { col: 8, row: 4 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'caret', cols: -7 });
  });

  it('zero caret delta falls through to keyboard', () => {
    const ctx: TapContext = {
      ...base,
      promptRow: 4,
      tapped: { col: 5, row: 4 },
      cursor: { col: 5, row: 4 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'keyboard' });
  });

  it('a tap off the prompt row falls through to the output-zone check', () => {
    const ctx: TapContext = {
      ...base,
      promptRow: 4,
      tapped: { col: 3, row: 2 },
      cursor: { col: 0, row: 0 },
      outputZone: { start: 0, end: 5 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'menuRow', rows: 2 });
  });

  it('walks a menu-row highlight inside an output zone', () => {
    const ctx: TapContext = {
      ...base,
      outputZone: { start: 0, end: 10 },
      tapped: { col: 0, row: 7 },
      cursor: { col: 0, row: 3 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'menuRow', rows: 4 });
  });

  it('walks the menu row upward when tapped above the cursor', () => {
    const ctx: TapContext = {
      ...base,
      outputZone: { start: 0, end: 10 },
      tapped: { col: 0, row: 1 },
      cursor: { col: 0, row: 6 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'menuRow', rows: -5 });
  });

  it('zero menu-row delta falls through to keyboard', () => {
    const ctx: TapContext = {
      ...base,
      outputZone: { start: 0, end: 10 },
      tapped: { col: 0, row: 3 },
      cursor: { col: 0, row: 3 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'keyboard' });
  });

  it('a tap outside the zone with no prompt row raises the keyboard', () => {
    const ctx: TapContext = {
      ...base,
      outputZone: { start: 0, end: 5 },
      tapped: { col: 0, row: 20 },
      cursor: { col: 0, row: 0 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'keyboard' });
  });

  it('no promptRow and no outputZone raises the keyboard', () => {
    expect(resolveTap({ ...base, tapped: { col: 5, row: 5 } })).toEqual({ kind: 'keyboard' });
  });

  it('clamps caret delta at maxDelta in both directions', () => {
    const right: TapContext = {
      ...base,
      promptRow: 0,
      tapped: { col: 1000, row: 0 },
      cursor: { col: 0, row: 0 },
      maxDelta: 50,
    };
    expect(resolveTap(right)).toEqual({ kind: 'caret', cols: 50 });

    const left: TapContext = {
      ...base,
      promptRow: 0,
      tapped: { col: 0, row: 0 },
      cursor: { col: 1000, row: 0 },
      maxDelta: 50,
    };
    expect(resolveTap(left)).toEqual({ kind: 'caret', cols: -50 });
  });

  it('clamps menu-row delta at maxDelta in both directions', () => {
    const down: TapContext = {
      ...base,
      outputZone: { start: 0, end: 1000 },
      tapped: { col: 0, row: 1000 },
      cursor: { col: 0, row: 0 },
      maxDelta: 30,
    };
    expect(resolveTap(down)).toEqual({ kind: 'menuRow', rows: 30 });

    const up: TapContext = {
      ...base,
      outputZone: { start: 0, end: 1000 },
      tapped: { col: 0, row: 0 },
      cursor: { col: 0, row: 1000 },
      maxDelta: 30,
    };
    expect(resolveTap(up)).toEqual({ kind: 'menuRow', rows: -30 });
  });

  it('defaults maxDelta to 200', () => {
    const ctx: TapContext = {
      ...base,
      promptRow: 0,
      tapped: { col: 1000, row: 0 },
      cursor: { col: 0, row: 0 },
    };
    expect(resolveTap(ctx)).toEqual({ kind: 'caret', cols: 200 });
  });
});

describe('tapActionBytes', () => {
  it('produces the exact caret bytes for +3', () => {
    expect(tapActionBytes({ kind: 'caret', cols: 3 })).toBe('\x1b[C\x1b[C\x1b[C');
  });

  it('produces the exact caret bytes for -3', () => {
    expect(tapActionBytes({ kind: 'caret', cols: -3 })).toBe('\x1b[D\x1b[D\x1b[D');
  });

  it('produces the exact menu-row bytes for +3', () => {
    expect(tapActionBytes({ kind: 'menuRow', rows: 3 })).toBe('\x1b[B\x1b[B\x1b[B');
  });

  it('produces the exact menu-row bytes for -3', () => {
    expect(tapActionBytes({ kind: 'menuRow', rows: -3 })).toBe('\x1b[A\x1b[A\x1b[A');
  });

  it('emits empty bytes for mouse, link and keyboard actions', () => {
    expect(tapActionBytes({ kind: 'mouse' })).toBe('');
    expect(tapActionBytes({ kind: 'link', url: 'https://example.com' })).toBe('');
    expect(tapActionBytes({ kind: 'keyboard' })).toBe('');
  });

  it('never emits a carriage return or newline, across all action kinds', () => {
    const actions: Array<Parameters<typeof tapActionBytes>[0]> = [
      { kind: 'mouse' },
      { kind: 'link', url: 'https://example.com' },
      { kind: 'keyboard' },
      { kind: 'caret', cols: 5 },
      { kind: 'caret', cols: -5 },
      { kind: 'menuRow', rows: 5 },
      { kind: 'menuRow', rows: -5 },
    ];
    for (const action of actions) {
      const bytes = tapActionBytes(action);
      expect(bytes).not.toContain('\r');
      expect(bytes).not.toContain('\n');
    }
  });
});
