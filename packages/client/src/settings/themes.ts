// ── Color themes (client) ─────────────────────────────────────────────────────
//
// Client-only theme application: the xterm.js ITheme (canvas) and the app-wide
// CSS token/accent vars. The palette DATA + all colour math live in
// @palmux/shared (theme-colors) so the SERVER resolves the identical palette for
// the theme.sh export (shell/tmux/delta unification). This module re-exports the
// shared API unchanged, so existing `./themes` importers keep working.

import type { ITheme } from '@xterm/xterm';
import { deriveUiTokens, hex, isLightBg, luminance, type ColorProfile } from '@palmux/shared';

export {
  ACCENT_NAMES,
  allProfiles,
  COLOR_PROFILES,
  DEFAULT_THEME_ID,
  deriveAccents,
  deriveUiTokens,
  getProfile,
  hex,
  isLightBg,
  luminance,
  mix,
  nearest256,
  registerDynamicThemes,
  resolveThemePalette,
} from '@palmux/shared';
export type { AccentName, ColorProfile, ThemeColor, ThemePalette, UiTokens } from '@palmux/shared';

export function toXtermTheme(profile: ColorProfile): ITheme {
  const a = profile.ansi16;
  return {
    foreground: hex(profile.fg),
    background: hex(profile.bg),
    cursor: hex(profile.cursor ?? profile.fg),
    cursorAccent: hex(profile.bg),
    selectionBackground: hex(a[7] ?? profile.fg) + '66',
    // xterm 6's scrollbar is VS Code's slider widget, whose default grey ignores
    // the palette. Tint it with the theme's own colors instead, at the three
    // opacities the widget distinguishes (rest / hover / drag). Kept although
    // index.css now hides the slider on every device: the keys cost nothing, and
    // deleting them would make un-hiding it silently ship VS Code's grey.
    scrollbarSliderBackground: hex(a[8] ?? profile.fg) + '55',
    scrollbarSliderHoverBackground: hex(a[8] ?? profile.fg) + '88',
    scrollbarSliderActiveBackground: hex(a[7] ?? profile.fg) + 'bb',
    black: hex(a[0]!),
    red: hex(a[1]!),
    green: hex(a[2]!),
    yellow: hex(a[3]!),
    blue: hex(a[4]!),
    magenta: hex(a[5]!),
    cyan: hex(a[6]!),
    white: hex(a[7]!),
    brightBlack: hex(a[8]!),
    brightRed: hex(a[9]!),
    brightGreen: hex(a[10]!),
    brightYellow: hex(a[11]!),
    brightBlue: hex(a[12]!),
    brightMagenta: hex(a[13]!),
    brightCyan: hex(a[14]!),
    brightWhite: hex(a[15]!),
  };
}

const INK_DARK = '#10101a';
const INK_LIGHT = '#f2f2f8';

/** Ink (text) color for a background of the given luminance — WCAG-ish. */
const inkFor = (n: number): string => (luminance(n) > 0.5 ? INK_DARK : INK_LIGHT);

/**
 * Skin the WHOLE app to a theme: all seven `--t-*` UI tokens plus the sixteen
 * `--tab-c-ansi*` slot vars (+ their `-ink` text colors), so the topbar/
 * panels/drawer/controls follow the terminal palette — not just the xterm
 * canvas. `color-scheme` follows the background so native scrollbars/
 * controls match. Called at boot (main.tsx, pre-paint) and on every theme
 * change (App).
 */
/** Set (or create) a `<meta name>` content — used to sync browser/PWA chrome. */
function setMetaContent(name: string, content: string): void {
  if (typeof document === 'undefined') return;
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('name', name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

export function applyThemeTokens(profile: ColorProfile): void {
  const root = document.documentElement;
  const t = deriveUiTokens(profile);
  root.style.setProperty('--t-base', hex(t.base));
  root.style.setProperty('--t-mantle', hex(t.mantle));
  root.style.setProperty('--t-surface', hex(t.surface));
  root.style.setProperty('--t-text', hex(t.text));
  root.style.setProperty('--t-subtext', hex(t.subtext));
  root.style.setProperty('--t-accent', hex(t.accent));
  root.style.setProperty('--t-accent-ink', inkFor(t.accent));
  root.style.setProperty('--t-accent-alt', hex(t.accentAlt));
  // The TERMINAL's own background, distinct from --t-base (which is derived for
  // the UI chrome). Anything that has to sit flush against the grid — the
  // wrapper behind the sub-cell remainder — needs this one, not the derived one.
  root.style.setProperty('--t-term-bg', hex(profile.bg));
  const scheme = isLightBg(profile) ? 'light' : 'dark';
  root.style.setProperty('color-scheme', scheme);
  profile.ansi16.forEach((c, n) => {
    root.style.setProperty(`--tab-c-ansi${n}`, hex(c));
    root.style.setProperty(`--tab-c-ansi${n}-ink`, inkFor(c));
  });
  // Sync the browser/PWA chrome color to the active theme (was hardcoded Mocha
  // in index.html). Runs pre-paint in main.tsx and on every live theme change.
  setMetaContent('theme-color', hex(profile.bg));
  setMetaContent('color-scheme', scheme);
}
