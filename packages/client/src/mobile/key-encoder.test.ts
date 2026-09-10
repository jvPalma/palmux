import {
  encodeExtraKey,
  encodeMacro,
  NO_MODS,
  MODIFIER_NAMES,
  KEY_MAP,
  CTRL_NONLETTER,
} from './key-encoder';

const ctrl = { ctrl: true, alt: false, shift: false };
const alt = { ctrl: false, alt: true, shift: false };
const shift = { ctrl: false, alt: false, shift: true };
const ctrlShift = { ctrl: true, alt: false, shift: true };

describe('encodeExtraKey — printable characters', () => {
  it('emits the bare char with no modifiers', () => {
    expect(encodeExtraKey('a')).toBe('a');
    expect(encodeExtraKey('a', NO_MODS)).toBe('a');
  });

  it('maps Ctrl+letter to its control code', () => {
    expect(encodeExtraKey('c', ctrl)).toBe('\x03');
    expect(encodeExtraKey('a', ctrl)).toBe('\x01');
    expect(encodeExtraKey('z', ctrl)).toBe('\x1a');
  });

  it('treats Ctrl+letter case-insensitively', () => {
    expect(encodeExtraKey('C', ctrl)).toBe('\x03');
  });

  it('uppercases letters under Shift', () => {
    expect(encodeExtraKey('a', shift)).toBe('A');
  });

  it('maps non-letter Ctrl combos via CTRL_NONLETTER', () => {
    expect(encodeExtraKey(']', ctrl)).toBe('\x1d');
    expect(encodeExtraKey('\\', ctrl)).toBe('\x1c');
    expect(encodeExtraKey('^', ctrl)).toBe('\x1e');
    expect(encodeExtraKey('_', ctrl)).toBe('\x1f');
    expect(encodeExtraKey(' ', ctrl)).toBe('\x00');
  });

  it('ESC-prefixes a char under Alt', () => {
    expect(encodeExtraKey('a', alt)).toBe('\x1ba');
  });

  it('falls through to ESC-prefix when Ctrl has no control code for the char', () => {
    // '/' has no ctrl code → emits '/', then alt would prefix; here ctrl only
    expect(encodeExtraKey('/', ctrl)).toBe('/');
  });
});

describe('encodeExtraKey — named keys', () => {
  it('encodes simple named keys', () => {
    expect(encodeExtraKey('ESC')).toBe('\x1b');
    expect(encodeExtraKey('UP')).toBe('\x1b[A');
    expect(encodeExtraKey('DOWN')).toBe('\x1b[B');
    expect(encodeExtraKey('RIGHT')).toBe('\x1b[C');
    expect(encodeExtraKey('LEFT')).toBe('\x1b[D');
    expect(encodeExtraKey('HOME')).toBe('\x1b[H');
    expect(encodeExtraKey('END')).toBe('\x1b[F');
  });

  it('is case-insensitive on the key name', () => {
    expect(encodeExtraKey('up')).toBe('\x1b[A');
    expect(encodeExtraKey('Esc')).toBe('\x1b');
  });

  it('encodes CSI cursor keys with a modifier code', () => {
    expect(encodeExtraKey('UP', ctrl)).toBe('\x1b[1;5A');
    expect(encodeExtraKey('UP', shift)).toBe('\x1b[1;2A');
    expect(encodeExtraKey('UP', alt)).toBe('\x1b[1;3A');
    expect(encodeExtraKey('UP', ctrlShift)).toBe('\x1b[1;6A');
  });

  it('encodes tilde keys with a modifier code', () => {
    expect(encodeExtraKey('DEL')).toBe('\x1b[3~');
    expect(encodeExtraKey('DEL', ctrl)).toBe('\x1b[3;5~');
    expect(encodeExtraKey('PGUP', ctrl)).toBe('\x1b[5;5~');
  });

  it('encodes SS3 function keys with a modifier code when modified', () => {
    expect(encodeExtraKey('F1')).toBe('\x1bOP');
    expect(encodeExtraKey('F1', ctrl)).toBe('\x1b[1;5P');
    expect(encodeExtraKey('F5')).toBe('\x1b[15~');
    expect(encodeExtraKey('F5', ctrl)).toBe('\x1b[15;5~');
  });

  it('special-cases Tab and Shift+Tab', () => {
    expect(encodeExtraKey('TAB')).toBe('\t');
    expect(encodeExtraKey('TAB', shift)).toBe('\x1b[Z');
  });

  it('special-cases Enter under Alt', () => {
    expect(encodeExtraKey('ENTER')).toBe('\r');
    expect(encodeExtraKey('ENTER', alt)).toBe('\x1b\r');
    expect(encodeExtraKey('RETURN')).toBe('\r');
  });

  it('special-cases Backspace modifiers (xterm: DEL / ^H / ESC DEL)', () => {
    expect(encodeExtraKey('BKSP')).toBe('\x7f');
    // ^H, not ^W: the shell decides what a "word" is via its ^H binding, and
    // sending ^W bypassed that binding entirely.
    expect(encodeExtraKey('BKSP', ctrl)).toBe('\x08');
    expect(encodeExtraKey('BKSP', alt)).toBe('\x1b\x7f');
  });

  it('encodes SPACE through the char path', () => {
    expect(encodeExtraKey('SPACE')).toBe(' ');
    expect(encodeExtraKey('SPACE', ctrl)).toBe('\x00');
  });
});

describe('encodeExtraKey — edge cases', () => {
  it('returns empty string for modifier-only names', () => {
    expect(encodeExtraKey('CTRL')).toBe('');
    expect(encodeExtraKey('ALT')).toBe('');
    expect(encodeExtraKey('SHIFT')).toBe('');
    expect(encodeExtraKey('FN')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(encodeExtraKey('')).toBe('');
  });

  it('sends unknown multi-char tokens literally, ESC-prefixed under Alt', () => {
    expect(encodeExtraKey('XYZ')).toBe('XYZ');
    expect(encodeExtraKey('XYZ', alt)).toBe('\x1bXYZ');
  });
});

describe('encodeMacro', () => {
  it('applies a leading modifier to the next token only', () => {
    expect(encodeMacro('CTRL d')).toBe('\x04');
  });

  it('chains multiple modifier+key pairs', () => {
    expect(encodeMacro('CTRL a CTRL k')).toBe('\x01\x0b');
  });

  it('resets pending modifiers after each non-modifier token', () => {
    // CTRL applies to 'a' only; 'b' is bare
    expect(encodeMacro('CTRL a b')).toBe('\x01b');
  });

  it('ignores FN tokens', () => {
    expect(encodeMacro('FN d')).toBe('d');
  });

  it('tolerates extra whitespace', () => {
    expect(encodeMacro('  CTRL   d  ')).toBe('\x04');
  });

  it('Ctrl wins over Alt for a control-coded char (returns the control byte)', () => {
    // encodeChar returns the control code immediately when ctrl applies, so the
    // Alt ESC-prefix is not added.
    expect(encodeMacro('CTRL ALT a')).toBe('\x01');
  });
});

describe('exported tables', () => {
  it('exposes MODIFIER_NAMES', () => {
    expect(MODIFIER_NAMES.has('CTRL')).toBe(true);
    expect(MODIFIER_NAMES.has('FN')).toBe(true);
  });

  it('exposes KEY_MAP and CTRL_NONLETTER', () => {
    expect(KEY_MAP['ArrowUp']).toBe('\x1b[A');
    expect(CTRL_NONLETTER[']']).toBe(0x1d);
  });
});
