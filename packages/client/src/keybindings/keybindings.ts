// ── Desktop keybinding registry ───────────────────────────────────────────────
//
// A rebindable action registry that sits ABOVE xterm.js: a capture-phase handler
// (see useKeybindings) resolves a physical-keyboard chord to an Action and runs
// it, but ONLY for explicitly-bound chords — every unbound key falls through to
// xterm untouched (so DECCKM/DECKPAM and all default encoding are preserved).
// Bindings persist per-device in localStorage and default to the map below.

export type Action =
  | 'commandPalette'
  | 'search'
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'settings'
  | 'openSettingsJson'
  | 'tips'
  | 'diagnostics'
  | 'exportScrollback'
  | 'copyLastOutput'
  | 'dictate'
  | 'dictationHistory'
  | 'uploadFile'
  | 'downloadFile'
  | 'splitRight'
  | 'splitDown'
  | 'toggleSplitOrientation'
  | 'increaseFontSize'
  | 'decreaseFontSize'
  | 'resetFontSize';

export const ACTIONS: readonly Action[] = [
  'commandPalette',
  'search',
  'newTab',
  'closeTab',
  'nextTab',
  'prevTab',
  'settings',
  'openSettingsJson',
  'tips',
  'diagnostics',
  'exportScrollback',
  'copyLastOutput',
  'dictate',
  'dictationHistory',
  'uploadFile',
  'downloadFile',
  'splitRight',
  'splitDown',
  'toggleSplitOrientation',
  'increaseFontSize',
  'decreaseFontSize',
  'resetFontSize',
];

export const ACTION_LABELS: Record<Action, string> = {
  commandPalette: 'Command palette',
  search: 'Search scrollback',
  newTab: 'New tab',
  closeTab: 'Close tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  settings: 'Open settings',
  openSettingsJson: 'Open settings (JSON)',
  tips: 'Open tips',
  diagnostics: 'Copy diagnostics report',
  exportScrollback: 'Export scrollback',
  copyLastOutput: 'Copy last command output',
  dictate: 'Dictate (voice → text)',
  dictationHistory: 'Dictation history',
  uploadFile: 'Upload a file',
  downloadFile: 'Download from the server',
  splitRight: 'Split right',
  splitDown: 'Split down',
  toggleSplitOrientation: 'Toggle split orientation',
  increaseFontSize: 'Increase font size',
  decreaseFontSize: 'Decrease font size',
  resetFontSize: 'Reset font size',
};

export interface Chord {
  /** Normalised key: a single lowercased char, or a named key (`Tab`, `ArrowUp`). */
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export const DEFAULT_BINDINGS: Record<Action, Chord> = {
  commandPalette: { key: 'p', ctrl: true, shift: true },
  search: { key: 'f', ctrl: true, shift: true },
  newTab: { key: 't', ctrl: true, shift: true },
  closeTab: { key: 'w', ctrl: true, shift: true },
  nextTab: { key: 'Tab', ctrl: true },
  prevTab: { key: 'Tab', ctrl: true, shift: true },
  settings: { key: ',', ctrl: true },
  openSettingsJson: { key: 'j', ctrl: true, shift: true },
  tips: { key: '/', ctrl: true },
  diagnostics: { key: 'i', ctrl: true, shift: true },
  exportScrollback: { key: 's', ctrl: true, shift: true },
  copyLastOutput: { key: 'g', ctrl: true, shift: true },
  dictate: { key: 'd', ctrl: true, alt: true },
  dictationHistory: { key: 'h', ctrl: true, alt: true },
  uploadFile: { key: 'u', ctrl: true, alt: true },
  downloadFile: { key: 'k', ctrl: true, alt: true },
  splitRight: { key: 'd', ctrl: true, shift: true },
  splitDown: { key: 'e', ctrl: true, shift: true },
  toggleSplitOrientation: { key: 'o', ctrl: true, shift: true },
  increaseFontSize: { key: '=', ctrl: true },
  decreaseFontSize: { key: '-', ctrl: true },
  resetFontSize: { key: '0', ctrl: true },
};

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function sanitizeChord(c: Chord): Chord {
  const out: Chord = { key: normalizeKey(String(c.key)) };
  if (c.ctrl) out.ctrl = true;
  if (c.alt) out.alt = true;
  if (c.shift) out.shift = true;
  if (c.meta) out.meta = true;
  return out;
}

export function chordFromEvent(e: KeyboardEvent): Chord {
  const chord: Chord = { key: normalizeKey(e.key) };
  if (e.ctrlKey) chord.ctrl = true;
  if (e.altKey) chord.alt = true;
  if (e.shiftKey) chord.shift = true;
  if (e.metaKey) chord.meta = true;
  return chord;
}

export function chordEq(a: Chord, b: Chord): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    !!a.ctrl === !!b.ctrl &&
    !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift &&
    !!a.meta === !!b.meta
  );
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

/** Resolve a keydown to a bound Action, or null if nothing matches / bare modifier. */
export function matchAction(bindings: Record<Action, Chord>, e: KeyboardEvent): Action | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const chord = chordFromEvent(e);
  for (const action of ACTIONS) {
    if (chordEq(chord, bindings[action])) return action;
  }
  return null;
}

/** Another action already bound to `chord` (for the editor's conflict check). */
export function findConflict(
  bindings: Record<Action, Chord>,
  action: Action,
  chord: Chord,
): Action | null {
  for (const a of ACTIONS) {
    if (a !== action && chordEq(bindings[a], chord)) return a;
  }
  return null;
}

/** Human-readable chord, e.g. `Ctrl+Shift+P`. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return parts.join('+');
}

const STORAGE_KEY = 'palmux-keybindings';

export function loadBindings(): Record<Action, Chord> {
  const merged: Record<Action, Chord> = { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Record<Action, Chord>>;
      for (const action of ACTIONS) {
        const c = stored[action];
        if (c && typeof c.key === 'string') merged[action] = sanitizeChord(c);
      }
    }
  } catch {
    /* ignore — fall back to defaults */
  }
  return merged;
}

export function saveBindings(bindings: Record<Action, Chord>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    /* ignore */
  }
}

export function resetBindings(): Record<Action, Chord> {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_BINDINGS };
}
