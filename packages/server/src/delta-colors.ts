// ── git-delta diff colours ────────────────────────────────────────────────────
//
// The user's diff palette lives in their git config, where `delta` already keeps
// a dark and a light variant. Reading it here means diffs look the same in git,
// lazygit and Claude Code without anyone maintaining a second copy — the
// gitconfig stays the single source and palmux only picks the polarity.
//
// We shell out to `git config` rather than parsing the INI ourselves: git
// resolves `include`s, precedence and escaping, and it is the only parser
// guaranteed to agree with what delta itself will see. `--global` because a
// server daemon has no meaningful CWD, so a repo-local delta section is not ours
// to pick up.
//
// The dark/light feature names are DISCOVERED (`delta.<name>.dark = true` /
// `.light = true`) instead of hardcoded, so this works for any delta setup that
// splits its palette in the conventional way.

import { execFileSync } from 'node:child_process';

/** The six diff backgrounds, as 0xRRGGBB. Missing entries fall back to the palette. */
export interface DiffColors {
  added?: number;
  removed?: number;
  addedWord?: number;
  removedWord?: number;
  addedDimmed?: number;
  removedDimmed?: number;
}

/** delta style key → the Claude Code diff key it feeds. */
const STYLE_MAP: Array<[string, keyof DiffColors]> = [
  ['plus-style', 'added'],
  ['minus-style', 'removed'],
  ['plus-emph-style', 'addedWord'],
  ['minus-emph-style', 'removedWord'],
  ['plus-non-emph-style', 'addedDimmed'],
  ['minus-non-emph-style', 'removedDimmed'],
];

/**
 * The BACKGROUND of a delta style string. delta writes `<fg> <attrs> <bg>`, so
 * with the usual `syntax bold #6b2020` the colour we want is the LAST hex —
 * `syntax` names the foreground. A style with no hex at all (`red`, `auto`,
 * `normal`) yields null and leaves that key on the palette default.
 */
export function styleBackground(style: string): number | null {
  const hexes = style.match(/#[0-9a-fA-F]{6}\b/g);
  if (!hexes?.length) return null;
  return parseInt(hexes[hexes.length - 1]!.slice(1), 16);
}

/** Parse `git config --get-regexp` output into `{ 'delta.x.y': 'value' }`. */
export function parseGitConfig(out: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const at = line.indexOf(' ');
    if (at <= 0) continue;
    map[line.slice(0, at)] = line.slice(at + 1);
  }
  return map;
}

/**
 * Split a delta config into its dark and light diff palettes. Feature sections
 * are found by their own `dark`/`light` flag; a delta with no such split falls
 * back to the bare `delta.<style>` keys for BOTH polarities (one palette used
 * everywhere is still better than ignoring the user's colours).
 */
export function deltaDiffColors(config: Record<string, string>): {
  dark: DiffColors;
  light: DiffColors;
} {
  const feature = (flag: 'dark' | 'light'): string | null => {
    for (const [key, value] of Object.entries(config)) {
      const m = new RegExp(`^delta\\.(.+)\\.${flag}$`).exec(key);
      if (m && value === 'true') return m[1]!;
    }
    return null;
  };
  const collect = (prefix: string): DiffColors => {
    const out: DiffColors = {};
    for (const [style, key] of STYLE_MAP) {
      const raw = config[`${prefix}${style}`];
      const bg = raw === undefined ? null : styleBackground(raw);
      if (bg !== null) out[key] = bg;
    }
    return out;
  };
  const bare = collect('delta.');
  const dark = feature('dark');
  const light = feature('light');
  return {
    dark: dark ? { ...bare, ...collect(`delta.${dark}.`) } : bare,
    light: light ? { ...bare, ...collect(`delta.${light}.`) } : bare,
  };
}

/** Read the user's delta diff palette. Never throws — no git, no config, no problem. */
export function readDeltaDiffColors(): { dark: DiffColors; light: DiffColors } {
  try {
    const out = execFileSync('git', ['config', '--global', '--get-regexp', '^delta\\.'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return deltaDiffColors(parseGitConfig(out));
  } catch {
    return { dark: {}, light: {} }; // no git / no delta section → palette defaults
  }
}
