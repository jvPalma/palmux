// ── External theme discovery ──────────────────────────────────────────────────
//
// Discover color themes the user already has, so they show up in palmux's theme
// picker alongside the built-ins (and can be exported to the shell via theme.sh):
//   • user files:  ~/.config/palmux/themes/*.conf (Xresources), *.json (WT/VSCode),
//                  *.yml / *.sh (Gogh — dropped in by hand or by the URL importer)
//   • system:      ~/.Xresources
//   • auto-discovery of common emulators: key/value formats (Kitty, Ghostty,
//     Termux), Alacritty (TOML), and WezTerm (Lua) — each via its own parser.
//
// Every path is best-effort: a missing file or an unparseable one is skipped, and
// discovery never throws (a bad theme must never break boot).

import { existsSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import {
  type ColorProfile,
  parseAlacrittyTheme,
  parseGoghTheme,
  parseKeyValueTheme,
  parseWezTermTheme,
  parseWindowsTerminalScheme,
} from '@palmux/shared';
import { configDir } from './config';

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'theme';

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function themesDir(): string {
  return join(configDir(), 'themes');
}

/** User theme files: `~/.config/palmux/themes/*.{conf,json}`. */
function discoverUserThemes(): ColorProfile[] {
  let entries: string[];
  try {
    entries = readdirSync(themesDir());
  } catch {
    return []; // no themes dir → nothing
  }
  const out: ColorProfile[] = [];
  for (const name of entries) {
    const ext = extname(name).toLowerCase();
    const base = basename(name, ext);
    const text = safeRead(join(themesDir(), name));
    if (text === null) continue;
    const id = `user:${slug(base)}`;
    try {
      const p =
        ext === '.json'
          ? parseWindowsTerminalScheme(JSON.parse(text), id)
          : ext === '.yml' || ext === '.yaml' || ext === '.sh'
            ? parseGoghTheme(text, id, base)
            : parseKeyValueTheme(text, id, base);
      if (p) out.push(p);
      else console.error(`palmux: theme file has no fg/bg, skipping: ${name}`);
    } catch {
      console.error(`palmux: unparseable theme file, skipping: ${name}`);
    }
  }
  return out;
}

// Fixed, user-owned config locations + the parser for each format. Built lazily
// so it reflects the current $HOME (os.homedir()) at call time.
type ThemeParser = (text: string, id: string, name: string) => ColorProfile | null;
function emulatorSources(): { id: string; name: string; path: string; parse: ThemeParser }[] {
  const h = homedir();
  return [
    { id: 'system', name: 'System (Xresources)', path: join(h, '.Xresources'), parse: parseKeyValueTheme }, // prettier-ignore
    { id: 'kitty', name: 'Kitty', path: join(h, '.config', 'kitty', 'kitty.conf'), parse: parseKeyValueTheme }, // prettier-ignore
    { id: 'ghostty', name: 'Ghostty', path: join(h, '.config', 'ghostty', 'config'), parse: parseKeyValueTheme }, // prettier-ignore
    { id: 'termux', name: 'Termux', path: join(h, '.termux', 'colors.properties'), parse: parseKeyValueTheme }, // prettier-ignore
    { id: 'alacritty', name: 'Alacritty', path: join(h, '.config', 'alacritty', 'alacritty.toml'), parse: parseAlacrittyTheme }, // prettier-ignore
    { id: 'wezterm', name: 'WezTerm', path: join(h, '.config', 'wezterm', 'wezterm.lua'), parse: parseWezTermTheme }, // prettier-ignore
  ];
}

/** Best-effort auto-discovery of common emulator themes. */
function discoverEmulatorThemes(): ColorProfile[] {
  const out: ColorProfile[] = [];
  for (const src of emulatorSources()) {
    if (!existsSync(src.path)) continue;
    const text = safeRead(src.path);
    if (text === null) continue;
    const p = src.parse(text, src.id, src.name);
    if (p) out.push(p); // no-fg/bg emulator config → silently skipped
  }
  return out;
}

/** All discovered external themes (user files + system + emulator). Never throws. */
export function discoverThemes(): ColorProfile[] {
  try {
    return [...discoverUserThemes(), ...discoverEmulatorThemes()];
  } catch {
    return [];
  }
}

/** Watch the user themes dir; call `onChange` (debounced) when it changes. Returns
 *  a disposer. */
export function watchThemes(onChange: () => void): () => void {
  let w: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // CREATE the dir before watching. This runs once at boot, so a dir that only
    // appears later (the first URL import, or a hand-dropped file) would other-
    // wise never be watched at all — imports would need a reload to show up.
    mkdirSync(themesDir(), { recursive: true });
    w = watch(themesDir(), () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    });
    w.unref?.();
  } catch {
    /* config dir not writable — theme hot-reload is a convenience, never fatal */
  }
  return () => {
    clearTimeout(timer);
    w?.close();
  };
}
