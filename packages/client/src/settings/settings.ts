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
/** Whether the side dock keeps a permanent icon rail. Per-device: `always` is
 *  right on a desktop and wrong on a phone, so a synced value is wrong on one
 *  of them. */
export type SidebarRailPref = 'always' | 'hidden';
export type CursorStyle = 'block' | 'underline' | 'bar';

// A type alias (not interface) so it stays assignable to JsonValue for the
// server-synced settings blob.
export type QuickLink = { name: string; url: string };

export interface ClientSettings {
  /** Per-device, local-only: terminal zoom (pinch/±). Never synced to the server. */
  fontSize: number;
  fontFamily: string;
  themeId: string;
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  /** Per-device, local-only: force the mobile layer on/off, or auto-detect. */
  mobileMode: MobileModePref;
  /** Per-device, local-only: keep the dock's icon rail permanently visible.
   *  Deliberately absent from SYNCED_KEYS — see the comment there. */
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
// `sidebarRail` in particular must never be added here: a value that follows you
// from a desktop to a phone is wrong on one of them, and a synced copy would put
// a per-machine value back into the dotfiles-tracked settings.json that
// settings.local.json exists to keep it out of. `themeId` is the odd
// one out: it IS synced, because the server reads it at boot to regenerate the
// tmux/delta/Claude theme exports with no browser connected — but the server
// then persists it per-machine, to settings.local.json. See LOCAL_SETTINGS_KEYS
// in server/config.ts.
const SYNCED_KEYS = [
  'fontFamily',
  'themeId',
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
