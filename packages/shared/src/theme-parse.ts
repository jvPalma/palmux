// ── External terminal-theme parsers ───────────────────────────────────────────
//
// Parse user/emulator color themes into a `ColorProfile` (the same shape the
// built-in profiles use). Pure functions — no I/O — so they unit-test cleanly and
// run on both the server (discovery) and, if ever needed, the client.
//
// Input shapes covered:
//  • key/value text (Xresources, Kitty, Termux, Ghostty) — `parseKeyValueTheme`
//  • Windows-Terminal / VS Code JSON color schemes — `parseWindowsTerminalScheme`
//  • Alacritty TOML (`[colors.primary|normal|bright]` tables) — `parseAlacrittyTheme`
//  • WezTerm Lua (`foreground`/`background` + `ansi`/`brights` arrays) — `parseWezTermTheme`
//  • Gogh YAML / install script (`color_01`…`color_16`, 1-indexed) — `parseGoghTheme`
//
// Anything omitted (a missing ANSI slot) is backfilled from the foreground so the
// result always has a full 16-colour palette; the token/accent derivation handles
// the rest. fg + bg are REQUIRED — without both we return null (not a theme).

import type { ColorProfile } from './theme-colors';

/** "#rrggbb" | "rrggbb" | "0xrrggbb" | "#rgb" → 0xRRGGBB, else null. */
export function parseHexColor(input: string): number | null {
  let s = input.trim();
  // Strip surrounding quotes (TOML/JSON-ish values) and a leading 0x / #.
  s = s.replace(/^["']|["']$/g, '').trim();
  s = s.replace(/^0x/i, '').replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(s)) return parseInt(s, 16);
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[0]!;
    const g = s[1]!;
    const b = s[2]!;
    return parseInt(r + r + g + g + b + b, 16);
  }
  return null;
}

/**
 * Parse a key/value color theme. Handles `:` (Xresources), `=` (Termux/Ghostty),
 * and whitespace (Kitty) as the key/value separator; `colorN` / `color N` keys;
 * and Ghostty's `palette = N=#hex` lines. Requires foreground + background.
 */
export function parseKeyValueTheme(text: string, id: string, name: string): ColorProfile | null {
  let fg: number | null = null;
  let bg: number | null = null;
  const ansi: (number | null)[] = Array.from({ length: 16 }, () => null);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('//')) continue;

    // Ghostty: `palette = 0=#1d2021`
    const pal = /palette\s*[:=]\s*([0-9]{1,2})\s*=\s*(\S+)/i.exec(line);
    if (pal) {
      const n = Number(pal[1]);
      const val = parseHexColor(pal[2]!);
      if (val !== null && n >= 0 && n < 16) ansi[n] = val;
      continue;
    }

    // Split on the first `:`, `=`, or run of whitespace.
    const m = /^([^\s:=]+)\s*[:=\s]\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.trim();
    const val = parseHexColor(m[2]!);
    if (val === null) continue;

    const colorKey = /(?:^|[.*])color\s*([0-9]{1,2})$/i.exec(key);
    if (colorKey) {
      const n = Number(colorKey[1]);
      if (n >= 0 && n < 16) ansi[n] = val;
      continue;
    }
    if (/(?:^|[.*])foreground$/i.test(key)) fg = val;
    else if (/(?:^|[.*])background$/i.test(key)) bg = val;
  }

  if (fg === null || bg === null) return null;
  const ansi16 = ansi.map((c) => (c === null ? fg! : c));
  return { id, name, fg, bg, ansi16 };
}

// The eight standard ANSI color names, in slot order (0–7 normal, 8–15 bright).
// Shared by the Alacritty and (implicitly) WezTerm array-order parsers.
const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

/** First `#rrggbb`/`0xrrggbb` (or #rgb) token in a value, ignoring quotes and
 *  trailing inline comments. Returns 0xRRGGBB, else null. */
function firstHex(value: string): number | null {
  const m = /(?:#|0x)[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?/i.exec(value);
  return m ? parseHexColor(m[0]) : null;
}

/**
 * Parse an Alacritty TOML color config. Colors live under three tables:
 * `[colors.primary]` (foreground/background), `[colors.normal]` (slots 0–7 by
 * ANSI name), and `[colors.bright]` (slots 8–15). Values are `"#rrggbb"` or
 * `"0xrrggbb"`. Requires foreground + background; anything else backfills from fg.
 */
export function parseAlacrittyTheme(text: string, id: string, name: string): ColorProfile | null {
  let fg: number | null = null;
  let bg: number | null = null;
  const ansi: (number | null)[] = Array.from({ length: 16 }, () => null);
  let section = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sec = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (sec) {
      section = sec[1]!.replace(/["'\s]/g, '').toLowerCase();
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = firstHex(line.slice(eq + 1));
    if (val === null) continue;

    if (section === 'colors.primary') {
      if (key === 'foreground') fg = val;
      else if (key === 'background') bg = val;
    } else if (section === 'colors.normal' || section === 'colors.bright') {
      const i = ANSI_NAMES.indexOf(key as (typeof ANSI_NAMES)[number]);
      if (i >= 0) ansi[section === 'colors.bright' ? 8 + i : i] = val;
    }
  }

  if (fg === null || bg === null) return null;
  const ansi16 = ansi.map((c) => (c === null ? fg! : c));
  return { id, name, fg, bg, ansi16 };
}

/**
 * Parse a WezTerm Lua color config. WezTerm expresses colors as `foreground` /
 * `background` string keys plus `ansi = { … }` (slots 0–7) and `brights = { … }`
 * (slots 8–15) arrays. Best-effort regex extraction (no Lua eval): built-in named
 * `color_scheme`s can't be resolved without WezTerm's scheme DB and are skipped.
 * Requires foreground + background; missing slots backfill from fg.
 */
export function parseWezTermTheme(text: string, id: string, name: string): ColorProfile | null {
  const clean = text.replace(/--.*$/gm, ''); // strip Lua line comments
  const grabKey = (k: string): number | null => {
    const m = new RegExp(`\\b${k}\\s*=\\s*['"]((?:#|0x)?[0-9a-fA-F]{3,6})['"]`, 'i').exec(clean);
    return m ? parseHexColor(m[1]!) : null;
  };
  const grabArray = (k: string): number[] => {
    const m = new RegExp(`\\b${k}\\s*=\\s*\\{([^}]*)\\}`, 'i').exec(clean);
    const toks = m ? m[1]!.match(/(?:#|0x)[0-9a-fA-F]{3,6}/gi) : null;
    return (toks ?? []).map((t) => parseHexColor(t)).filter((n): n is number => n !== null);
  };

  const fg = grabKey('foreground');
  const bg = grabKey('background');
  if (fg === null || bg === null) return null;

  const ansi16: number[] = Array.from({ length: 16 }, () => fg);
  grabArray('ansi')
    .slice(0, 8)
    .forEach((c, i) => (ansi16[i] = c));
  grabArray('brights')
    .slice(0, 8)
    .forEach((c, i) => (ansi16[8 + i] = c));
  return { id, name, fg, bg, ansi16 };
}

// Windows-Terminal / VS Code scheme keys, in ANSI-slot order. WT names the
// magenta slots `purple` / `brightPurple`.
const WT_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'purple',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightPurple',
  'brightCyan',
  'brightWhite',
] as const;

/** Parse a Windows-Terminal / VS Code JSON color scheme into a ColorProfile. */
export function parseWindowsTerminalScheme(json: unknown, id: string): ColorProfile | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const fgStr = str('foreground');
  const bgStr = str('background');
  const fg = fgStr ? parseHexColor(fgStr) : null;
  const bg = bgStr ? parseHexColor(bgStr) : null;
  if (fg === null || bg === null) return null;
  const ansi16: number[] = [];
  for (const k of WT_KEYS) {
    const raw = str(k);
    const v = raw ? parseHexColor(raw) : null;
    ansi16.push(v === null ? fg : v);
  }
  const nm = str('name');
  return { id, name: nm && nm.trim() ? nm : id, fg, bg, ansi16 };
}

/**
 * Parse a Gogh theme. Gogh publishes each theme twice — the canonical
 * `themes/<Name>.yml` (`color_01: '#262626'  # Black`) and a generated
 * `installs/<name>.sh` (`export COLOR_01="#262626"`) — which differ only in the
 * `export ` prefix and the quote style, so one parser reads both.
 *
 * The off-by-one matters: Gogh numbers its slots from ONE, so `color_01` is
 * ansi0 (black). Feeding these keys to the generic key/value parser would shift
 * the whole palette by a slot.
 */
export function parseGoghTheme(text: string, id: string, name: string): ColorProfile | null {
  let fg: number | null = null;
  let bg: number | null = null;
  let cursor: number | null = null;
  let title = '';
  const ansi: (number | null)[] = Array.from({ length: 16 }, () => null);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    const m = /^([A-Za-z_][A-Za-z_0-9]*)\s*[:=]\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!;

    const slot = /^color_?([0-9]{1,2})$/.exec(key);
    if (slot) {
      const n = Number(slot[1]) - 1; // Gogh counts from 1
      const v = firstHex(value);
      if (v !== null && n >= 0 && n < 16) ansi[n] = v;
      continue;
    }
    if (key === 'foreground' || key === 'foreground_color') fg = firstHex(value);
    else if (key === 'background' || key === 'background_color') bg = firstHex(value);
    else if (key === 'cursor' || key === 'cursor_color') cursor = firstHex(value);
    else if (key === 'name' || key === 'profile_name') {
      title = value.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
    }
  }

  if (fg === null || bg === null) return null;
  const ansi16 = ansi.map((c) => (c === null ? fg! : c));
  const profile: ColorProfile = { id, name: title || name, fg, bg, ansi16 };
  if (cursor !== null) profile.cursor = cursor;
  return profile;
}
