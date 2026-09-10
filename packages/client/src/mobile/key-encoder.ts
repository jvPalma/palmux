// ── Key → terminal byte encoder ───────────────────────────────────────────────
//
// One source of truth for turning a key (plus modifiers) into the xterm/VT
// bytes a terminal expects. Two callers share it:
//
//   • the physical-keyboard path (imports KEY_MAP/CTRL_NONLETTER)
//   • the on-screen Termux-style toolbar (uses encodeExtraKey / encodeMacro
//     with Termux key names)
//
// Keeping the tables here means the toolbar and the hardware keyboard can never
// drift into emitting different bytes for the same key.

// xterm-256color escape sequences for special keys, keyed by DOM
// KeyboardEvent.key. Consumed directly by the keyboard path and (via
// TERMUX_TO_DOMKEY) by the extra-keys toolbar.
export const KEY_MAP: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',

  Home: '\x1b[H',
  End: '\x1b[F',

  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',

  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',

  Escape: '\x1b',
  Tab: '\t',
  Enter: '\r',
  Backspace: '\x7f',
};

// Non-letter Ctrl combos (charCode & 0x1F):
//   Ctrl+]  = 0x1D  (vim: jump to tag)
//   Ctrl+\  = 0x1C
//   Ctrl+^  = 0x1E  (vim: alternate file)
//   Ctrl+_  = 0x1F
//   Ctrl+Space = 0x00 (NUL)
export const CTRL_NONLETTER: Record<string, number> = {
  ']': 0x1d,
  '\\': 0x1c,
  '^': 0x1e,
  _: 0x1f,
  ' ': 0x00,
};

export interface KeyMods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const NO_MODS: KeyMods = { ctrl: false, alt: false, shift: false };

// Key-name tokens that toggle a sticky modifier instead of emitting bytes.
// FN is recognised for Termux-config compatibility but has no web encoding.
export const MODIFIER_NAMES = new Set(['CTRL', 'ALT', 'SHIFT', 'FN']);

// Termux extra-key names → DOM KeyboardEvent.key, so the toolbar can reuse the
// same KEY_MAP / modifier math as the hardware keyboard.
const TERMUX_TO_DOMKEY: Record<string, string> = {
  ESC: 'Escape',
  TAB: 'Tab',
  ENTER: 'Enter',
  RETURN: 'Enter',
  BKSP: 'Backspace',
  BACKSPACE: 'Backspace',
  DEL: 'Delete',
  INS: 'Insert',
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',
  HOME: 'Home',
  END: 'End',
  PGUP: 'PageUp',
  PGDN: 'PageDown',
  SPACE: ' ',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
};

// xterm CSI modifier code: 1 + shift + 2·alt + 4·ctrl.
function modCode(mods: KeyMods): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

function anyMod(mods: KeyMods): boolean {
  return mods.ctrl || mods.alt || mods.shift;
}

// Control byte for a single character, or null if it has none.
function ctrlCode(ch: string): number | null {
  const lower = ch.toLowerCase();
  const code = lower.charCodeAt(0);
  if (code >= 97 && code <= 122) return code - 96; // a-z → 0x01..0x1a
  if (ch in CTRL_NONLETTER) return CTRL_NONLETTER[ch]!;
  return null;
}

// Encode a single printable character with sticky modifiers applied.
function encodeChar(ch: string, mods: KeyMods): string {
  let c = ch;
  // Shift uppercases letters; symbol shifting (e.g. '/'→'?') is layout-dependent
  // and intentionally not synthesised here.
  if (mods.shift) {
    const upper = c.toUpperCase();
    if (upper !== c.toLowerCase()) c = upper;
  }
  if (mods.ctrl) {
    const code = ctrlCode(c);
    if (code !== null) return String.fromCharCode(code);
    // No control code for this char → fall through (emit char, maybe ESC-prefixed).
  }
  if (mods.alt) return '\x1b' + c; // ESC prefix = Meta
  return c;
}

// Cursor/edit keys whose modified form is a CSI sequence with a modifier code.
const CSI_FINAL: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
};
const CSI_TILDE: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};
const SS3_FINAL: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

function encodeNamedKey(domKey: string, mods: KeyMods): string {
  if (domKey === ' ') return encodeChar(' ', mods);

  if (domKey === 'Tab') return mods.shift ? '\x1b[Z' : '\t';
  if (domKey === 'Escape') return '\x1b';
  if (domKey === 'Enter') return mods.alt ? '\x1b\r' : '\r'; // ESC prefix = Meta (xterm altSendsEscape / Termux)
  if (domKey === 'Backspace') {
    // xterm's convention, and what every desktop terminal sends: plain
    // Backspace is DEL, Ctrl+Backspace is BS (^H), Alt+Backspace is ESC DEL.
    // WHICH word each kills is the shell's business — zsh/readline bind ^H and
    // ESC-DEL to their own widgets — so the terminal must not editorialise by
    // substituting ^W here (that silently bypassed every ^H binding).
    if (mods.ctrl) return '\x08';
    if (mods.alt) return '\x1b\x7f';
    return '\x7f';
  }

  const m = modCode(mods);

  const final = CSI_FINAL[domKey];
  if (final) return anyMod(mods) ? `\x1b[1;${m}${final}` : KEY_MAP[domKey]!;

  const tilde = CSI_TILDE[domKey];
  if (tilde !== undefined) return anyMod(mods) ? `\x1b[${tilde};${m}~` : KEY_MAP[domKey]!;

  const ss3 = SS3_FINAL[domKey];
  if (ss3) return anyMod(mods) ? `\x1b[1;${m}${ss3}` : KEY_MAP[domKey]!;

  const seq = KEY_MAP[domKey] ?? '';
  return mods.alt && !mods.ctrl ? '\x1b' + seq : seq;
}

/**
 * Encode one extra-key activation (a Termux key name or a single printable
 * character) plus sticky modifiers into the raw string to send to the PTY.
 * Returns '' for modifier-only names (CTRL/ALT/SHIFT/FN) and unknown empty input.
 */
export function encodeExtraKey(name: string, mods: KeyMods = NO_MODS): string {
  if (!name) return '';
  const up = name.toUpperCase();
  if (MODIFIER_NAMES.has(up)) return '';

  // Single printable character (letters, digits, '/', '-', '|', …).
  if ([...name].length === 1) return encodeChar(name, mods);

  const domKey = TERMUX_TO_DOMKEY[up];
  if (domKey) return encodeNamedKey(domKey, mods);

  // Unknown multi-char token → send literally (ESC-prefixed under Alt).
  return mods.alt && !mods.ctrl ? '\x1b' + name : name;
}

/**
 * Encode a Termux macro: a space-separated sequence of key names. Modifier
 * tokens (CTRL/ALT/SHIFT) apply to the next non-modifier token only, exactly
 * like Termux. e.g. "CTRL d" → ^D (0x04); "CTRL a CTRL k" → ^A^K.
 */
export function encodeMacro(macro: string): string {
  let out = '';
  let pending: KeyMods = { ...NO_MODS };
  const reset = () => {
    pending = { ...NO_MODS };
  };
  for (const token of macro.trim().split(/\s+/)) {
    if (!token) continue;
    const up = token.toUpperCase();
    if (up === 'CTRL') {
      pending.ctrl = true;
      continue;
    }
    if (up === 'ALT') {
      pending.alt = true;
      continue;
    }
    if (up === 'SHIFT') {
      pending.shift = true;
      continue;
    }
    if (up === 'FN') continue; // recognised, no web encoding
    out += encodeExtraKey(token, pending);
    reset();
  }
  return out;
}
