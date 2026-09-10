// git-delta diff palette: the user's gitconfig is the single source for the six
// diff backgrounds, split into dark/light by delta's own feature flags.

import { describe, expect, it } from 'vitest';
import { deltaDiffColors, parseGitConfig, styleBackground } from './delta-colors';

// A real-world config: two feature sections, each flagged with its polarity.
const CONFIG = `delta.features dark-mode
delta.navigate true
delta.dark-mode.dark true
delta.dark-mode.minus-style syntax #200202
delta.dark-mode.plus-style syntax #163D52
delta.dark-mode.minus-emph-style syntax bold #6b2020
delta.dark-mode.plus-emph-style syntax bold #1F4A5C
delta.dark-mode.minus-non-emph-style syntax #200202
delta.dark-mode.plus-non-emph-style syntax #092332
delta.dark-mode.whitespace-error-style reverse red
delta.light-mode.light true
delta.light-mode.minus-style syntax #ffebe9
delta.light-mode.plus-style syntax #ddf4ff
delta.light-mode.minus-emph-style syntax bold #ffc9c2
delta.light-mode.plus-emph-style syntax bold #a5d6ff`;

describe('styleBackground', () => {
  it('takes the LAST hex — delta writes <fg> <attrs> <bg>', () => {
    expect(styleBackground('syntax bold #6b2020')).toBe(0x6b2020);
    expect(styleBackground('syntax #200202')).toBe(0x200202);
    // An explicit fg AND bg: the background is the second one.
    expect(styleBackground('#ffffff #003300')).toBe(0x003300);
  });

  it('is null for a style with no hex, so the palette default survives', () => {
    expect(styleBackground('reverse red')).toBeNull();
    expect(styleBackground('normal')).toBeNull();
    expect(styleBackground('auto auto')).toBeNull();
  });

  it('ignores a short or over-long hex-looking token', () => {
    expect(styleBackground('syntax #abc')).toBeNull();
    expect(styleBackground('syntax #1234567')).toBeNull();
  });
});

describe('parseGitConfig', () => {
  it('splits each line on the FIRST space (values contain spaces)', () => {
    const map = parseGitConfig(CONFIG);
    expect(map['delta.dark-mode.minus-emph-style']).toBe('syntax bold #6b2020');
    expect(map['delta.features']).toBe('dark-mode');
  });

  it('skips blank and malformed lines', () => {
    expect(parseGitConfig('\n\nnokeyorvalue\n')).toEqual({});
  });
});

describe('deltaDiffColors', () => {
  it('discovers the feature names from delta own dark/light flags', () => {
    const { dark, light } = deltaDiffColors(parseGitConfig(CONFIG));
    expect(dark).toEqual({
      removed: 0x200202,
      added: 0x163d52,
      removedWord: 0x6b2020,
      addedWord: 0x1f4a5c,
      removedDimmed: 0x200202,
      addedDimmed: 0x092332,
    });
    // The light section defines only four styles; the rest stay unset so the
    // palette fills them, rather than leaking dark colours onto a light theme.
    expect(light).toEqual({
      removed: 0xffebe9,
      added: 0xddf4ff,
      removedWord: 0xffc9c2,
      addedWord: 0xa5d6ff,
    });
  });

  it('falls back to the bare delta.* keys when there is no dark/light split', () => {
    const flat = parseGitConfig(
      'delta.minus-style syntax #330000\ndelta.plus-style syntax #003300',
    );
    const { dark, light } = deltaDiffColors(flat);
    expect(dark).toEqual({ removed: 0x330000, added: 0x003300 });
    expect(light).toEqual(dark); // one palette is still better than none
  });

  it('lets a feature section override only what it redefines', () => {
    const mixed = parseGitConfig(
      [
        'delta.plus-style syntax #003300',
        'delta.minus-style syntax #330000',
        'delta.dark-mode.dark true',
        'delta.dark-mode.plus-style syntax #163D52',
      ].join('\n'),
    );
    expect(deltaDiffColors(mixed).dark).toEqual({ added: 0x163d52, removed: 0x330000 });
  });

  it('is empty for a config with no delta colours at all', () => {
    expect(deltaDiffColors(parseGitConfig('delta.navigate true'))).toEqual({
      dark: {},
      light: {},
    });
  });
});
