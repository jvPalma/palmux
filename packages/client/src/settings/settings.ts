// ── Client settings model ─────────────────────────────────────────────────────
//
// Rendering settings live in localStorage and are mirrored to the server (so
// they follow you across browsers) — except `mobileMode` and `fontSize`, which
// are per-device and stay local: zoom is device-specific (a phone pinch must
// not resize the terminal on your desktop). The server stores the synced subset
// as an opaque blob.

import type { JsonObject } from '@palmux/shared';
import { DEFAULT_THEME_ID } from './themes';
import { parsePins } from '../panes/explorer-pins';

export type MobileModePref = 'auto' | 'on' | 'off';
/** Kept only so an old settings.json still parses: the desktop rail is always
 *  shown now and nothing reads this for layout. */
export type SidebarRailPref = 'always' | 'hidden';
/** One theme everywhere (`fixed`), or one per system colour scheme (`system`). */
export type ThemeMode = 'fixed' | 'system';
/** The two system colour schemes a `system` theme is chosen for. */
export type ThemeSlot = 'dark' | 'light';
/** What a theme pick (or a finished import) is FOR. Captured when it is made, so
 *  an answer that lands after the user changed mode can tell it was superseded. */
export type ThemeTarget = { mode: 'fixed' } | { mode: 'system'; slot: ThemeSlot };
export type CursorStyle = 'block' | 'underline' | 'bar';

// A type alias (not interface) so it stays assignable to JsonValue for the
// server-synced settings blob.
export type QuickLink = { name: string; url: string };

export interface ClientSettings {
  /** Per-device, local-only: terminal zoom (pinch/±). Never synced to the server. */
  fontSize: number;
  fontFamily: string;
  /** The picked theme in `fixed` mode. In `system` mode it is only what the
   *  server exports (tmux, delta, Claude): this client writes it when its own
   *  colour scheme CHANGES, never on boot, and rendering never reads it. */
  themeId: string;
  themeMode: ThemeMode;
  /** The theme for a dark / light system scheme. '' = not chosen yet, which
   *  `themeId` stands in for; switching to `system` fills both from it. */
  themeDark: string;
  themeLight: string;
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  /** Per-device, local-only: force the mobile layer on/off, or auto-detect. */
  mobileMode: MobileModePref;
  /** Per-device, local-only and no longer read: see SidebarRailPref. */
  sidebarRail: SidebarRailPref;
  /** User-defined dashboard links; synced so every device shares them. */
  quickLinks: QuickLink[];
  /**
   * Folders pinned as Explorer roots, newest first. SYNCED, unlike the tab
   * groups' collapse set: these are paths on the SERVER's filesystem, so the
   * same list is correct on every device pointed at the same palmux.
   */
  explorerPins: string[];
  /** Intercept plain Ctrl+V as paste. Default OFF so vim/readline aren't broken. */
  ctrlVPaste: boolean;
  /** Intercept plain Ctrl+F as scrollback search. Default OFF. */
  ctrlFSearch: boolean;
  /** Let Shift+Arrow/Home/End start a keyboard text selection. Default OFF. */
  keyboardSelection: boolean;
  /** Pass Alt+digit through to the shell instead of claiming it. Default OFF. */
  altDigitPassthrough: boolean;
  /** Vim-style editing in app text inputs (command palette, etc.). Default OFF. */
  vimInputMode: boolean;
  /** Render inline images (SIXEL + iTerm2 IIP) instead of letting the escapes
   *  fall through as garbage. Also makes the terminal ANSWER DA1 as sixel-capable,
   *  which is how timg/chafa/yazi decide to send pixels at all. Default ON. */
  inlineImages: boolean;
  /** Per-device, local-only: show the keydown→paint latency debug overlay. Default OFF. */
  latencyOverlay: boolean;
  /** Per-device, local-only: EXPERIMENTAL — use the browser's native touch
   *  text-selection (invisible DOM text layer) instead of palmux's custom
   *  long-press handles. Default OFF; the custom selection remains the shipped
   *  behaviour until this is proven on real hardware. */
  nativeTouchSelection: boolean;
}

// Leads with the BUNDLED JetBrainsMono NF (non-Mono; see index.css @font-face)
// so the terminal renders instantly with full-size Nerd-Font glyphs; plain
// JetBrains Mono and system monospace follow as fallbacks.
export const DEFAULT_FONT_STACK =
  '"JetBrainsMono NF", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

export const FONT_PRESETS: { label: string; value: string }[] = [
  { label: 'JetBrainsMono NF (bundled)', value: DEFAULT_FONT_STACK },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'Fira Code', value: '"Fira Code", ui-monospace, Menlo, monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", ui-monospace, Menlo, monospace' },
  { label: 'Menlo / Consolas', value: 'Menlo, Consolas, ui-monospace, monospace' },
  { label: 'System monospace', value: 'ui-monospace, monospace' },
];

export const DEFAULTS: ClientSettings = {
  fontSize: 14,
  fontFamily: DEFAULT_FONT_STACK,
  themeId: DEFAULT_THEME_ID,
  themeMode: 'fixed',
  themeDark: '',
  themeLight: '',
  scrollback: 5000,
  cursorBlink: true,
  cursorStyle: 'block',
  mobileMode: 'auto',
  sidebarRail: 'always',
  quickLinks: [],
  explorerPins: [],
  ctrlVPaste: false,
  ctrlFSearch: false,
  keyboardSelection: false,
  altDigitPassthrough: false,
  vimInputMode: false,
  inlineImages: true,
  latencyOverlay: false,
  // On by default: the browser's own selection (handles + Copy/Share callout)
  // beats palmux's custom long-press handles on a phone. Turn it off to get the
  // custom handles + copy-on-select back.
  nativeTouchSelection: true,
};

const STORAGE_KEY = 'palmux-settings';

// Fields mirrored to the server. Per-device concerns (mobileMode, fontSize,
// sidebarRail) are deliberately excluded so they never roam across devices.
// `sidebarRail` in particular must never be added here: a synced copy would put
// a per-machine value back into the dotfiles-tracked settings.json that
// settings.local.json exists to keep it out of. `themeId` is the odd
// one out: it IS synced, because the server reads it at boot to regenerate the
// tmux/delta/Claude theme exports with no browser connected — but the server
// then persists it per-machine, to settings.local.json. See LOCAL_SETTINGS_KEYS
// in server/config.ts. The three new theme keys are plain synced settings:
// "dark -> X, light -> Y" is the same preference on every device. A client on an
// older bundle neither reads nor sends them, and the server replaces the whole
// object on every save, so such a client's next save erases them.
const SYNCED_KEYS = [
  'fontFamily',
  'themeId',
  'themeMode',
  'themeDark',
  'themeLight',
  'scrollback',
  'cursorBlink',
  'cursorStyle',
  'quickLinks',
  'explorerPins',
  'ctrlVPaste',
  'ctrlFSearch',
  'keyboardSelection',
  'altDigitPassthrough',
  'vimInputMode',
  'inlineImages',
] as const;

export function loadSettings(): ClientSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize({ ...DEFAULTS, ...(JSON.parse(raw) as object) });
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: ClientSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// Live settings-change subscription. Same-tab localStorage writes do NOT fire a
// `storage` event, so consumers that aren't the App's `useSettings` owner (e.g.
// the editor pane, which follows the terminal font size) subscribe here to react
// to changes live. `useSettings` calls `notifySettingsChange` on every update.
type SettingsListener = (s: ClientSettings) => void;
const settingsListeners = new Set<SettingsListener>();

export function onSettingsChange(cb: SettingsListener): () => void {
  settingsListeners.add(cb);
  return () => {
    settingsListeners.delete(cb);
  };
}

export function notifySettingsChange(s: ClientSettings): void {
  for (const cb of settingsListeners) cb(s);
}

/** The opaque blob sent to / persisted by the server (synced subset only). */
export function toServerSettings(s: ClientSettings): JsonObject {
  const out: JsonObject = {};
  for (const k of SYNCED_KEYS) out[k] = s[k];
  return out;
}

/** Merge a server settings blob over local settings (server wins for synced keys). */
export function mergeServerSettings(local: ClientSettings, server: JsonObject): ClientSettings {
  const next: ClientSettings = { ...local };
  for (const k of SYNCED_KEYS) {
    const v = server[k];
    if (typeof v === typeof DEFAULTS[k]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next as any)[k] = v;
    }
  }
  return sanitize(next);
}

export function sanitize(s: ClientSettings): ClientSettings {
  return {
    ...s,
    fontSize: clamp(Math.round(s.fontSize) || DEFAULTS.fontSize, 6, 48),
    scrollback: clamp(Math.round(s.scrollback) || DEFAULTS.scrollback, 0, 100000),
    cursorStyle: (['block', 'underline', 'bar'] as const).includes(s.cursorStyle)
      ? s.cursorStyle
      : DEFAULTS.cursorStyle,
    mobileMode: (['auto', 'on', 'off'] as const).includes(s.mobileMode)
      ? s.mobileMode
      : DEFAULTS.mobileMode,
    themeMode: (['fixed', 'system'] as const).includes(s.themeMode)
      ? s.themeMode
      : DEFAULTS.themeMode,
    themeDark: typeof s.themeDark === 'string' ? s.themeDark : DEFAULTS.themeDark,
    themeLight: typeof s.themeLight === 'string' ? s.themeLight : DEFAULTS.themeLight,
    sidebarRail: (['always', 'hidden'] as const).includes(s.sidebarRail)
      ? s.sidebarRail
      : DEFAULTS.sidebarRail,
    quickLinks: Array.isArray(s.quickLinks)
      ? s.quickLinks
          .filter(
            (l): l is QuickLink =>
              typeof l === 'object' &&
              l !== null &&
              typeof (l as QuickLink).name === 'string' &&
              typeof (l as QuickLink).url === 'string',
          )
          .map((l) => ({ name: l.name, url: l.url }))
      : [],
    explorerPins: parsePins(s.explorerPins),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/** True for any touch-capable device (coarse pointer or reported touch points). */
export function isMobileDevice(): boolean {
  const coarse =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return coarse || (navigator.maxTouchPoints ?? 0) > 0;
}

/** Resolve the mobile-layer on/off state from the tri-state preference. */
export function resolveMobileMode(pref: MobileModePref): boolean {
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return isMobileDevice();
}

export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** Whether THIS client's system colour scheme is dark right now. */
export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

type ThemeFields = Pick<ClientSettings, 'themeMode' | 'themeId' | 'themeDark' | 'themeLight'>;

/**
 * The ONE theme id this client renders. Every paint path reads this — the CSS
 * tokens, the terminal, the dynamic-themes refresh, the pre-paint in main.tsx —
 * and none reads `themeId`, which in `system` mode is only what the server
 * exports. Resolved from the client's own scheme, so two devices in different
 * schemes each show their own theme.
 */
export function resolveThemeId(s: ThemeFields, prefersDark: boolean): string {
  if (s.themeMode !== 'system') return s.themeId;
  return (prefersDark ? s.themeDark : s.themeLight) || s.themeId;
}

/**
 * What a theme pick (or a finished import) writes, or null when it is
 * superseded: the target was captured in one mode and the settings are now in
 * another. A fixed pick landing in `system` mode would overwrite the exported
 * `themeId` with no scheme change to justify it. In `system` mode a pick fills a
 * slot and never touches `themeId`; whether it shows at once is then decided by
 * `resolveThemeId`, i.e. only when that slot is the active scheme.
 *
 * Comparing modes is enough for a pick, which is applied as it is made. It is
 * NOT enough for an import, which can land after Fixed → Match system → Fixed:
 * the modes match again, and the late answer would overwrite whatever the user
 * picked after coming back. App therefore also checks a mode GENERATION for
 * imports (see `themeModeAfter`).
 */
export function themePick(
  s: Pick<ClientSettings, 'themeMode'>,
  target: ThemeTarget,
  id: string,
): Partial<ClientSettings> | null {
  if (target.mode !== s.themeMode) return null;
  if (target.mode === 'fixed') return { themeId: id };
  return target.slot === 'dark' ? { themeDark: id } : { themeLight: id };
}

/**
 * The theme mode a server settings blob leaves this client in. App counts mode
 * transitions as broadcasts ARRIVE, because React can fold two of them into one
 * render and a round trip would then look like no change; so it needs the
 * answer before the merge runs. A blob without the key (an older bundle's save)
 * keeps `current`. Delegating to `mergeServerSettings` keeps the two agreeing
 * on every value, an unknown one included.
 */
export function themeModeAfter(current: ThemeMode, server: JsonObject): ThemeMode {
  return mergeServerSettings({ ...DEFAULTS, themeMode: current }, server).themeMode;
}

/**
 * What switching mode writes. `shown` is the theme on screen: into `system` an
 * unchosen slot starts at the current theme, and back to `fixed` the pick is
 * what is showing — both so the switch itself changes nothing the eye can see.
 */
export function themeModeChange(
  s: Pick<ClientSettings, 'themeId' | 'themeDark' | 'themeLight'>,
  mode: ThemeMode,
  shown: string,
): Partial<ClientSettings> {
  if (mode === 'fixed') return { themeMode: 'fixed', themeId: shown };
  return {
    themeMode: 'system',
    themeDark: s.themeDark || s.themeId,
    themeLight: s.themeLight || s.themeId,
  };
}
