import {
  toExtraKey,
  isModifierKey,
  keyLabel,
  normalizeLayout,
  parseTermuxExtraKeys,
  mergeExtraKeys,
  DEFAULT_EXTRA_KEYS,
  DEFAULT_LAYOUT,
} from './extra-keys';

describe('toExtraKey', () => {
  it('wraps a bare string into a key object', () => {
    expect(toExtraKey('ESC')).toEqual({ key: 'ESC' });
  });

  it('passes through an object spec unchanged', () => {
    const spec = { key: 'a', display: 'A' };
    expect(toExtraKey(spec)).toBe(spec);
  });
});

describe('isModifierKey', () => {
  it('is true for modifier names', () => {
    expect(isModifierKey('CTRL')).toBe(true);
    expect(isModifierKey('alt')).toBe(true);
    expect(isModifierKey({ key: 'SHIFT' })).toBe(true);
  });

  it('is false for non-modifier keys', () => {
    expect(isModifierKey('ESC')).toBe(false);
    expect(isModifierKey('a')).toBe(false);
  });

  it('is false when the spec is a macro', () => {
    expect(isModifierKey({ key: 'CTRL', macro: 'CTRL d' })).toBe(false);
  });
});

describe('keyLabel', () => {
  it('prefers display, then key, then macro, then ?', () => {
    expect(keyLabel({ display: 'Esc', key: 'ESC' })).toBe('Esc');
    expect(keyLabel({ key: 'ESC' })).toBe('ESC');
    expect(keyLabel({ macro: 'CTRL d' })).toBe('CTRL d');
    expect(keyLabel({})).toBe('?');
  });

  it('works on a bare string', () => {
    expect(keyLabel('TAB')).toBe('TAB');
  });
});

describe('normalizeLayout', () => {
  it('returns [] for non-array input', () => {
    expect(normalizeLayout(null)).toEqual([]);
    expect(normalizeLayout('nope')).toEqual([]);
    expect(normalizeLayout({})).toEqual([]);
  });

  it('drops non-array rows', () => {
    expect(normalizeLayout(['notarow', ['ESC']])).toEqual([['ESC']]);
  });

  it('keeps bare-string keys as strings', () => {
    expect(normalizeLayout([['ESC', 'TAB']])).toEqual([['ESC', 'TAB']]);
  });

  it('trims string keys and drops empty ones', () => {
    expect(normalizeLayout([['  ESC  ', '   ']])).toEqual([['ESC']]);
  });

  it('drops rows that end up empty', () => {
    expect(normalizeLayout([['   '], ['ESC']])).toEqual([['ESC']]);
  });

  it('keeps object form when it carries extra fields', () => {
    expect(normalizeLayout([[{ key: 'a', display: 'A' }]])).toEqual([[{ key: 'a', display: 'A' }]]);
  });

  it('preserves a long-press action and keeps the key as an object', () => {
    expect(normalizeLayout([[{ key: 'ESC', action: 'keyboard' }]])).toEqual([
      [{ key: 'ESC', action: 'keyboard' }],
    ]);
  });

  it('collapses a key-only object back to a bare string', () => {
    expect(normalizeLayout([[{ key: 'ESC' }]])).toEqual([['ESC']]);
  });

  it('drops keys with nothing to send', () => {
    expect(normalizeLayout([[{ display: 'X' }, 'ESC']])).toEqual([['ESC']]);
  });

  it('accepts a macro-only key', () => {
    expect(normalizeLayout([[{ macro: 'CTRL d' }]])).toEqual([[{ macro: 'CTRL d' }]]);
  });

  it('normalizes nested popup objects', () => {
    expect(normalizeLayout([[{ key: '-', popup: { key: '_' } }]])).toEqual([
      [{ key: '-', popup: { key: '_' } }],
    ]);
  });

  it('keeps a string popup', () => {
    expect(normalizeLayout([[{ key: '-', popup: '_' }]])).toEqual([[{ key: '-', popup: '_' }]]);
  });
});

describe('parseTermuxExtraKeys', () => {
  it('parses a JSON array-of-arrays', () => {
    expect(parseTermuxExtraKeys('[["ESC","TAB"],["UP","DOWN"]]')).toEqual([
      ['ESC', 'TAB'],
      ['UP', 'DOWN'],
    ]);
  });

  it('tolerates trailing-backslash line continuation', () => {
    const input = '[["ESC","/","-","HOME","UP","END","PGUP"], \\\n["TAB","CTRL","ALT"]]';
    expect(parseTermuxExtraKeys(input)).toEqual([
      ['ESC', '/', '-', 'HOME', 'UP', 'END', 'PGUP'],
      ['TAB', 'CTRL', 'ALT'],
    ]);
  });

  it('throws on empty input', () => {
    expect(() => parseTermuxExtraKeys('   ')).toThrow(/empty/);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTermuxExtraKeys('not json')).toThrow(/not valid JSON/);
  });

  it('throws when no usable rows result', () => {
    expect(() => parseTermuxExtraKeys('[[],["   "]]')).toThrow(/no usable rows/);
  });
});

describe('mergeExtraKeys', () => {
  it('returns defaults for non-object input', () => {
    expect(mergeExtraKeys(null)).toBe(DEFAULT_EXTRA_KEYS);
    expect(mergeExtraKeys('x')).toBe(DEFAULT_EXTRA_KEYS);
  });

  it('honors an explicit enabled flag', () => {
    expect(mergeExtraKeys({ enabled: false, layout: [['ESC']] })).toEqual({
      enabled: false,
      layout: [['ESC']],
    });
  });

  it('defaults enabled when not a boolean', () => {
    const merged = mergeExtraKeys({ enabled: 'yes', layout: [['ESC']] });
    expect(merged.enabled).toBe(DEFAULT_EXTRA_KEYS.enabled);
  });

  it('falls back to DEFAULT_LAYOUT when layout is unusable', () => {
    const merged = mergeExtraKeys({ enabled: true, layout: 'garbage' });
    expect(merged.layout).toBe(DEFAULT_LAYOUT);
  });
});
