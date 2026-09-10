// ── Color themes (SHARED) ─────────────────────────────────────────────────────
//
// Pure palette data + math shared by the client (xterm ITheme, UI tokens) and
// the server (theme.sh export → shell/tmux/delta colour unification). No DOM, no
// xterm types. ansi16 is [black,red,green,yellow,blue,magenta,cyan,white,bright…].

/** The seven CSS design tokens every piece of app chrome reads. */
export interface UiTokens {
  base: number;
  mantle: number;
  surface: number;
  text: number;
  subtext: number;
  accent: number;
  accentAlt: number;
}

/** The tab-accent palette names (persisted as opaque strings on tabs). */
export type AccentName =
  | 'red'
  | 'peach'
  | 'maroon'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'sky'
  | 'blue'
  | 'lavender'
  | 'mauve'
  | 'pink'
  | 'gray';

export const ACCENT_NAMES: AccentName[] = [
  'red',
  'peach',
  'maroon',
  'yellow',
  'green',
  'teal',
  'sky',
  'blue',
  'lavender',
  'mauve',
  'pink',
  'gray',
];

export interface ColorProfile {
  id: string;
  name: string;
  fg: number;
  bg: number;
  ansi16: number[];
  /** Explicit cursor colour; defaults to `fg` when omitted. */
  cursor?: number;
  /** Explicit UI-token overrides; anything omitted is derived. */
  ui?: Partial<UiTokens>;
  /** Explicit accent overrides; anything omitted is derived from ansi16. */
  accents?: Partial<Record<AccentName, number>>;
}

export const COLOR_PROFILES: ColorProfile[] = [
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    fg: 0xcdd6f4,
    bg: 0x1e1e2e,
    ansi16: [
      0x45475a, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xcdd6f4, 0x585b70,
      0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xb4befe,
    ],
    // Canonical Catppuccin tokens — keeps the DEFAULT theme pixel-identical.
    ui: {
      mantle: 0x181825,
      surface: 0x313244,
      subtext: 0x9399b2,
      accent: 0xa6e3a1,
      accentAlt: 0xfab387,
    },
    accents: {
      red: 0xf38ba8,
      peach: 0xfab387,
      maroon: 0xeba0ac,
      yellow: 0xf9e2af,
      green: 0xa6e3a1,
      teal: 0x94e2d5,
      sky: 0x89dceb,
      blue: 0x89b4fa,
      lavender: 0xb4befe,
      mauve: 0xcba6f7,
      pink: 0xf5c2e7,
      gray: 0x9399b2,
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    fg: 0xf8f8f2,
    bg: 0x282a36,
    ansi16: [
      0x21222c, 0xff5555, 0x50fa7b, 0xf1fa8c, 0xbd93f9, 0xff79c6, 0x8be9fd, 0xf8f8f2, 0x6272a4,
      0xff6e6e, 0x69ff94, 0xffffa5, 0xd6acff, 0xff92df, 0xa4ffff, 0xffffff,
    ],
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    fg: 0xc0caf5,
    bg: 0x1a1b26,
    ansi16: [
      0x15161e, 0xf7768e, 0x9ece6a, 0xe0af68, 0x7aa2f7, 0xbb9af7, 0x7dcfff, 0xa9b1d6, 0x414868,
      0xf7768e, 0x9ece6a, 0xe0af68, 0x7aa2f7, 0xbb9af7, 0x7dcfff, 0xc0caf5,
    ],
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    fg: 0xebdbb2,
    bg: 0x282828,
    ansi16: [
      0x282828, 0xcc241d, 0x98971a, 0xd79921, 0x458588, 0xb16286, 0x689d6a, 0xa89984, 0x928374,
      0xfb4934, 0xb8bb26, 0xfabd2f, 0x83a598, 0xd3869b, 0x8ec07c, 0xebdbb2,
    ],
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    fg: 0xabb2bf,
    bg: 0x282c34,
    ansi16: [
      0x3f4451, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xabb2bf, 0x4f5666,
      0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xffffff,
    ],
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    fg: 0x839496,
    bg: 0x002b36,
    ansi16: [
      0x073642, 0xdc322f, 0x859900, 0xb58900, 0x268bd2, 0xd33682, 0x2aa198, 0xeee8d5, 0x002b36,
      0xcb4b16, 0x586e75, 0x657b83, 0x839496, 0x6c71c4, 0x93a1a1, 0xfdf6e3,
    ],
  },
  {
    id: 'pure-black',
    name: 'Pure Black',
    fg: 0xf8f8f2,
    bg: 0x000000,
    ansi16: [
      0x21222c, 0xff5555, 0x50fa7b, 0xf1fa8c, 0xbd93f9, 0xff79c6, 0x8be9fd, 0xf8f8f2, 0x6272a4,
      0xff6e6e, 0x69ff94, 0xffffa5, 0xd6acff, 0xff92df, 0xa4ffff, 0xffffff,
    ],
  },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    fg: 0xbfbdb6,
    bg: 0x0d1017,
    ansi16: [
      0x01060e, 0xea6c6b, 0x91b362, 0xf9af4f, 0x53bdfa, 0xfae994, 0x90e1c6, 0xc7c7c7, 0x686868,
      0xf07178, 0xc2d94c, 0xffb454, 0x59c2ff, 0xffee99, 0x95e6cb, 0xffffff,
    ],
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    fg: 0x4c4f69,
    bg: 0xeff1f5,
    ansi16: [
      0x5c5f77, 0xd20f39, 0x40a02b, 0xdf8e1d, 0x1e66f5, 0xea76cb, 0x179299, 0xacb0be, 0x6c6f85,
      0xd20f39, 0x40a02b, 0xdf8e1d, 0x1e66f5, 0xea76cb, 0x179299, 0xbcc0cc,
    ],
    ui: {
      mantle: 0xe6e9ef,
      surface: 0xccd0da,
      subtext: 0x6c6f85,
      accent: 0x40a02b,
      accentAlt: 0xfe640b,
    },
    accents: {
      red: 0xd20f39,
      peach: 0xfe640b,
      maroon: 0xe64553,
      yellow: 0xdf8e1d,
      green: 0x40a02b,
      teal: 0x179299,
      sky: 0x04a5e5,
      blue: 0x1e66f5,
      lavender: 0x7287fd,
      mauve: 0x8839ef,
      pink: 0xea76cb,
      gray: 0x6c6f85,
    },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    fg: 0x24292f,
    bg: 0xffffff,
    ansi16: [
      0x24292f, 0xcf222e, 0x116329, 0x4d2d00, 0x0969da, 0x8250df, 0x1b7c83, 0x6e7781, 0x57606a,
      0xa40e26, 0x1a7f37, 0x633c01, 0x218bff, 0xa475f9, 0x3192aa, 0x8c959f,
    ],
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    fg: 0x657b83,
    bg: 0xfdf6e3,
    ansi16: [
      0x073642, 0xdc322f, 0x859900, 0xb58900, 0x268bd2, 0xd33682, 0x2aa198, 0xeee8d5, 0x002b36,
      0xcb4b16, 0x586e75, 0x657b83, 0x839496, 0x6c71c4, 0x93a1a1, 0xfdf6e3,
    ],
  },
  {
    id: 'palmux-light',
    name: 'Palmux Light',
    fg: 0x284863,
    bg: 0xfaf6ea,
    cursor: 0x5c9ee2,
    ansi16: [
      0x002b36, 0xdc322f, 0x629e05, 0xe3aa1d, 0x399ee6, 0xa37acc, 0x2aa198, 0xb5c4c9, 0x657b83,
      0xe7563e, 0x86b300, 0xf1b61e, 0x399ee6, 0xa37acc, 0x47c1b7, 0xcfdce0,
    ],
  },
];

export const DEFAULT_THEME_ID = 'catppuccin-mocha';

export function hex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

// Dynamically registered profiles: user theme files + discovered emulator themes.
// The server registers them on boot (so the theme.sh export can resolve a user
// theme by id); the client registers them when the `themes` message arrives.
// Consulted AFTER the built-ins, so a built-in id always wins.
let dynamicProfiles: ColorProfile[] = [];

export function registerDynamicThemes(profiles: ColorProfile[]): void {
  dynamicProfiles = profiles;
}

/** Built-in + dynamically-registered profiles (for the theme picker). */
export function allProfiles(): ColorProfile[] {
  return [...COLOR_PROFILES, ...dynamicProfiles];
}

/** Only the dynamically-registered profiles (for the server→client `themes` msg). */
export function dynamicThemes(): ColorProfile[] {
  return dynamicProfiles;
}

export function getProfile(id: string): ColorProfile {
  return (
    COLOR_PROFILES.find((p) => p.id === id) ??
    dynamicProfiles.find((p) => p.id === id) ??
    COLOR_PROFILES[0]!
  );
}

// ── Token / accent derivation ─────────────────────────────────────────────────

const clamp8 = (x: number): number => Math.max(0, Math.min(255, Math.round(x)));
const toRgb = (n: number): [number, number, number] => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const toNum = (r: number, g: number, b: number): number =>
  (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b);

/** Linear blend of two colors, `t` in 0..1 (0 = a, 1 = b). */
export function mix(a: number, b: number, t: number): number {
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  return toNum(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** Relative luminance (0..1) — WCAG-ish, used only to pick shade direction. */
export function luminance(n: number): number {
  const [r, g, b] = toRgb(n).map((v) => v / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const isLightBg = (p: ColorProfile): boolean => luminance(p.bg) > 0.5;

const BLACK = 0x000000;
const WHITE = 0xffffff;

/**
 * The twelve tab-accent colors for a profile: each taken from the theme's own
 * ansi16 palette (so they always look native to the theme), with peach/maroon/
 * sky/lavender/pink derived from the six base hues. Explicit `accents`
 * overrides win.
 */
export function deriveAccents(p: ColorProfile): Record<AccentName, number> {
  const a = p.ansi16;
  const base: Record<AccentName, number> = {
    red: a[1]!,
    peach: mix(a[1]!, a[3]!, 0.5),
    maroon: mix(a[1]!, BLACK, 0.18),
    yellow: a[3]!,
    green: a[2]!,
    teal: a[6]!,
    sky: mix(a[6]!, WHITE, 0.15),
    blue: a[4]!,
    lavender: mix(a[4]!, WHITE, 0.22),
    mauve: a[5]!,
    pink: mix(a[5]!, WHITE, 0.16),
    gray: a[8]!,
  };
  return { ...base, ...p.accents };
}

/**
 * The seven UI tokens. base/text come straight from bg/fg; surface (raised UI)
 * always moves TOWARD the fg for visible borders; mantle recesses; subtext dims
 * the fg. Mix factors are luminance-aware so light themes stay readable.
 * Explicit `ui` overrides win (used to pin the canonical Catppuccin values).
 */
export function deriveUiTokens(p: ColorProfile): UiTokens {
  const light = isLightBg(p);
  const acc = deriveAccents(p);
  const derived: UiTokens = {
    base: p.bg,
    text: p.fg,
    surface: mix(p.bg, p.fg, light ? 0.2 : 0.11),
    mantle: mix(p.bg, BLACK, light ? 0.04 : 0.2),
    subtext: mix(p.fg, p.bg, light ? 0.28 : 0.32),
    accent: acc.green,
    accentAlt: acc.peach,
  };
  return { ...derived, ...p.ui };
}

// ── Server export helpers (theme.sh) ──────────────────────────────────────────

/** Nearest xterm-256 palette index for an 0xRRGGBB colour (6×6×6 cube + grays).
 *  Used for tools that take an index, not hex (p10k). */
export function nearest256(rgb: number): number {
  const [r, g, b] = toRgb(rgb);
  const levels = [0, 95, 135, 175, 215, 255];
  const lvl = (v: number): number => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < 6; i++) {
      const d = Math.abs(levels[i]! - v);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const ri = lvl(r);
  const gi = lvl(g);
  const bi = lvl(b);
  const cubeDist = (levels[ri]! - r) ** 2 + (levels[gi]! - g) ** 2 + (levels[bi]! - b) ** 2;
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const avg = (r + g + b) / 3;
  const gStep = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + 10 * gStep;
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return grayDist < cubeDist ? 232 + gStep : cube;
}

/** A single resolved colour: hex `#rrggbb` and its nearest 256-index. */
export interface ThemeColor {
  hex: string;
  index: number;
}

/** The full resolved palette for a theme id — everything the theme.sh export
 *  needs: named UI colours, the 12 accents, and the 16 ANSI, each in both forms. */
export interface ThemePalette {
  id: string;
  name: string;
  light: boolean;
  colors: Record<string, ThemeColor>;
}

export function resolveThemePalette(themeId: string): ThemePalette {
  const p = getProfile(themeId);
  const accents = deriveAccents(p);
  const ui = deriveUiTokens(p);
  const c = (n: number): ThemeColor => ({ hex: hex(n), index: nearest256(n) });
  const colors: Record<string, ThemeColor> = {
    fg: c(p.fg),
    bg: c(p.bg),
    base: c(ui.base),
    mantle: c(ui.mantle),
    surface: c(ui.surface),
    text: c(ui.text),
    subtext: c(ui.subtext),
    accent: c(ui.accent),
    accent_alt: c(ui.accentAlt),
  };
  for (const name of ACCENT_NAMES) {
    colors[name] = c(accents[name]);
    // Muted variant: blend 30% toward the theme bg → soft segment backgrounds
    // that read well with a `text`-coloured foreground in BOTH light and dark.
    colors[`${name}_muted`] = c(mix(accents[name], p.bg, 0.3));
  }
  p.ansi16.forEach((n, i) => {
    colors[`ansi${i}`] = c(n);
  });
  return { id: p.id, name: p.name, light: isLightBg(p), colors };
}
