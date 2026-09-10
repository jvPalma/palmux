// ── Extra-keys (Termux-style) toolbar model ───────────────────────────────────
//
// Mirrors Termux's `extra-keys` configuration so a layout authored for Termux
// can be pasted in and Just Work. The schema is the same array-of-arrays of
// keys, where a key is either a bare name string or an object with
// {key, display, macro, popup}. We adopt Termux's *schema*, stored in
// palmux's own server-synced config.
//
// What each token emits is defined by key-encoder.ts (encodeExtraKey/encodeMacro),
// shared with the physical keyboard so a toolbar key and its hardware twin send
// identical bytes.

import { MODIFIER_NAMES } from './key-encoder';

/** A single toolbar key. A bare string is shorthand for `{ key: string }`. */
export interface ExtraKey {
  /** Key name (ESC, TAB, UP, …) or single character to send. */
  key?: string;
  /** Visible label override; purely cosmetic, decoupled from what is sent. */
  display?: string;
  /** Space-separated key sequence sent as one chord. Mutually exclusive with key. */
  macro?: string;
  /** Alternate key surfaced on long-press. Bare name or a nested key object. */
  popup?: ExtraKey | string;
  /**
   * A named UI action fired on long-press instead of a popup key (takes
   * precedence over `popup`). Today: `'keyboard'` — raise / dismiss the soft
   * keyboard on mobile (e.g. long-press ESC) — and `'dictate'`, which starts /
   * stops voice dictation. A tap still sends the key normally.
   *
   * An action is the only way a toolbar key can reach an APP feature: a macro
   * is encoded to bytes and handed to the PTY, so e.g. `"CTRL ALT d"` would
   * send ESC ^D to the shell rather than trigger anything in palmux.
   */
  action?: string;
}

export type ExtraKeySpec = string | ExtraKey;
export type ExtraKeysLayout = ExtraKeySpec[][];

export interface ExtraKeysConfig {
  /** Whether the toolbar is shown (only ever rendered on touch devices). */
  enabled: boolean;
  layout: ExtraKeysLayout;
}

// Termux's built-in default layout — the two-row arrows + modifiers set.
export const DEFAULT_LAYOUT: ExtraKeysLayout = [
  // Long-press ESC raises/dismisses the soft keyboard (mobile); a tap sends ESC.
  [{ key: 'ESC', action: 'keyboard' }, '/', '-', 'HOME', 'UP', 'END', 'PGUP'],
  ['TAB', 'CTRL', 'ALT', 'LEFT', 'DOWN', 'RIGHT', 'PGDN'],
];

export const DEFAULT_EXTRA_KEYS: ExtraKeysConfig = {
  enabled: true,
  layout: DEFAULT_LAYOUT,
};

/** Normalise a bare-string or object key spec into an ExtraKey object. */
export function toExtraKey(spec: ExtraKeySpec): ExtraKey {
  return typeof spec === 'string' ? { key: spec } : spec;
}

/** True when this key toggles a sticky modifier (CTRL/ALT/SHIFT/FN). */
export function isModifierKey(spec: ExtraKeySpec): boolean {
  const k = toExtraKey(spec);
  return !!k.key && !k.macro && MODIFIER_NAMES.has(k.key.toUpperCase());
}

/** The label to render for a key: explicit display → key → macro → '?'. */
export function keyLabel(spec: ExtraKeySpec): string {
  const k = toExtraKey(spec);
  if (k.display) return k.display;
  if (k.key) return k.key;
  if (k.macro) return k.macro;
  return '?';
}

// ── Validation / parsing ──────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeKey(raw: unknown): ExtraKey | null {
  if (typeof raw === 'string') {
    const key = raw.trim();
    return key ? { key } : null;
  }
  if (!isPlainObject(raw)) return null;

  const out: ExtraKey = {};
  if (typeof raw['key'] === 'string') out.key = raw['key'];
  if (typeof raw['display'] === 'string') out.display = raw['display'];
  if (typeof raw['macro'] === 'string') out.macro = raw['macro'];
  if (typeof raw['action'] === 'string') out.action = raw['action'];
  if (typeof raw['popup'] === 'string') {
    out.popup = raw['popup'];
  } else if (isPlainObject(raw['popup'])) {
    const p = normalizeKey(raw['popup']);
    if (p) out.popup = p;
  }
  // A key must carry something to send.
  if (!out.key && !out.macro) return null;
  return out;
}

/**
 * Normalise an arbitrary value (e.g. a parsed JSON blob from the server) into a
 * valid ExtraKeysLayout. Rows/keys that don't validate are dropped; returns []
 * if nothing usable is found.
 */
export function normalizeLayout(raw: unknown): ExtraKeysLayout {
  if (!Array.isArray(raw)) return [];
  const layout: ExtraKeysLayout = [];
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const keys: ExtraKeySpec[] = [];
    for (const cell of row) {
      const k = normalizeKey(cell);
      if (k) keys.push(k.display || k.macro || k.popup || k.action ? k : k.key!);
    }
    if (keys.length) layout.push(keys);
  }
  return layout;
}

/**
 * Parse a Termux `extra-keys` value (a JSON array-of-arrays) into a layout.
 * Tolerates the termux.properties trailing-backslash line-continuation quirk.
 * Throws on input that isn't valid JSON or yields no usable rows.
 */
export function parseTermuxExtraKeys(input: string): ExtraKeysLayout {
  // Strip the properties-file line-continuation artifact (`\` before a newline).
  const cleaned = input.replace(/\\\s*\r?\n/g, ' ').trim();
  if (!cleaned) throw new Error('empty extra-keys value');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`extra-keys is not valid JSON: ${(err as Error).message}`);
  }
  const layout = normalizeLayout(parsed);
  if (!layout.length) throw new Error('extra-keys contained no usable rows');
  return layout;
}

/**
 * Merge a server-supplied (free-form) config over the defaults. Invalid or
 * missing pieces fall back to the default. The server is authoritative; this
 * only fills gaps and rejects garbage.
 */
export function mergeExtraKeys(raw: unknown): ExtraKeysConfig {
  // A bare Termux-style array-of-arrays is shorthand for the layout.
  if (Array.isArray(raw)) {
    const layout = normalizeLayout(raw);
    return { enabled: true, layout: layout.length ? layout : DEFAULT_LAYOUT };
  }
  if (!isPlainObject(raw)) return DEFAULT_EXTRA_KEYS;
  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : DEFAULT_EXTRA_KEYS.enabled;
  const layout = normalizeLayout(raw['layout']);
  return {
    enabled,
    layout: layout.length ? layout : DEFAULT_LAYOUT,
  };
}
