// ── The one icon module ───────────────────────────────────────────────────────
//
// Every icon in the app's chrome comes from here. It used to be three registries
// and a pile of glyph characters: the dock drew seven SVGs at stroke 1.4/1.5/1.6
// on a 16 grid, the extra-keys bar drew its own at 1.75 on a 24 grid, the
// dictation view carried two more, and the rest of the chrome used emoji and
// text glyphs (✕ ☰ 📖 ⟳ …) — which render as whatever fallback face the platform
// has, at whatever weight it has. One wrapper fixes viewBox, stroke weight, caps
// and joins in one place, so an icon cannot drift from its neighbours.
//
// Sizing is by `width`/`height` ATTRIBUTES plus an inline vertical-align/flex pair,
// never a class: a stylesheet rule still wins over an attribute, which is how
// `.ek-key svg` keeps the bar's keys at 20px and `.ek-popup-hint svg` its corner
// hints at 10px. The inline style carries only what a stylesheet cannot be asked
// for per call site — baseline alignment next to text, and not shrinking in a
// flex row.
//
// Colour is `currentColor` everywhere, so hover/active/disabled states come free
// from the control that holds the icon.

import type { CSSProperties, ReactNode } from 'react';

// `-0.125em` seats a 16px icon on the text baseline the way a glyph character sat
// there; `flex: none` stops a long label beside it squeezing the icon narrower.
// `inline-block` is load-bearing: the bundle carries a preflight reset
// (`img, svg, … { display: block }`), so in a non-flex parent — the drawer's
// footer cells — the icon stacked ABOVE its label instead of sitting beside it.
const FRAME_STYLE: CSSProperties = {
  display: 'inline-block',
  verticalAlign: '-0.125em',
  flex: 'none',
};

/** The shared SVG frame. `ui/icons.tsx` registry entries and `mobile/key-icons.tsx`
 *  faces both draw inside it, which is what keeps one stroke weight across the app. */
export function IconFrame({
  children,
  size = 16,
}: {
  children: ReactNode;
  size?: number;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={FRAME_STYLE}
    >
      {children}
    </svg>
  );
}

// Drawn on a 24 grid with a 3-unit margin (content spans 3–21) so every glyph sits
// at the same optical size. Strokes only, with two deliberate exceptions:
//   * `dot` and `record` are SOLID. They are status marks (unsaved, recording),
//     and at 16px a 1.75 outline leaves a pinhole that reads as a ring, which is
//     a different statement. They keep the frame's stroke attributes and override
//     them on the shape, so every entry still renders through the same frame.
const GLYPHS = {
  // ── Extra-keys icons (the names `"icon"` accepts in extra-keys.json) ──
  // Two opposed arrows: move to another one of something (a tmux session).
  switch: (
    <>
      <path d="M5 8.5 H18" />
      <path d="M15 5.5 L18 8.5 L15 11.5" />
      <path d="M19 15.5 H6" />
      <path d="M9 12.5 L6 15.5 L9 18.5" />
    </>
  ),
  folder: (
    <path d="M3.5 7.5 V17.5 A1.5 1.5 0 0 0 5 19 H19 A1.5 1.5 0 0 0 20.5 17.5 V9.5 A1.5 1.5 0 0 0 19 8 H12 L10 5.5 H5 A1.5 1.5 0 0 0 3.5 7 Z" />
  ),
  // ↵ — a line break, not Enter's "submit".
  newline: (
    <>
      <path d="M19 5 V11.5 A3 3 0 0 1 16 14.5 H5.5" />
      <path d="M9 11 L5.5 14.5 L9 18" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="10.5" rx="3" />
      <path d="M5.5 11 A6.5 6.5 0 0 0 18.5 11" />
      <path d="M12 17.5 V20.5" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2" />
      <path d="M7 10.5 H7.01 M10.3 10.5 H10.31 M13.7 10.5 H13.71 M17 10.5 H17.01 M8.5 14 H15.5" />
    </>
  ),

  // ── Chrome ──
  close: <path d="M6 6 L18 18 M18 6 L6 18" />,
  menu: <path d="M4 6.5 H20 M4 12 H20 M4 17.5 H20" />,
  check: <path d="M5 12.5 L10 17.5 L19 7" />,
  warning: (
    <>
      <path d="M12 4 L21 19.5 H3 Z" />
      <path d="M12 10 V14" />
      <path d="M12 16.9 H12.01" />
    </>
  ),
  // A push pin: head, body and the needle that goes into the board.
  pin: (
    <>
      <path d="M8.5 4 H15.5 L14.5 9 L17.5 12.5 V14 H6.5 V12.5 L9.5 9 Z" />
      <path d="M12 14 V20.5" />
    </>
  ),
  'folder-open': (
    <>
      <path d="M3.5 17.5 V6.5 A1.5 1.5 0 0 1 5 5 H9.5 L11.5 7.5 H18 A1.5 1.5 0 0 1 19.5 9 V10.5" />
      <path d="M3.5 18 L5.9 12 A1.5 1.5 0 0 1 7.3 11 H21 L18.6 17 A1.5 1.5 0 0 1 17.2 18 H3.5" />
    </>
  ),
  file: (
    <>
      <path d="M14 3.5 H7 A1.5 1.5 0 0 0 5.5 5 V19 A1.5 1.5 0 0 0 7 20.5 H17 A1.5 1.5 0 0 0 18.5 19 V8 Z" />
      <path d="M14 3.5 V8 H18.5" />
    </>
  ),
  // An open book: two pages meeting at the spine.
  book: (
    <>
      <path d="M12 6.5 C10 5 7 4.5 3.5 5 V18 C7 17.5 10 18 12 19.5 C14 18 17 17.5 20.5 18 V5 C17 4.5 14 5 12 6.5 Z" />
      <path d="M12 6.5 V19.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12 H21" />
      <ellipse cx="12" cy="12" rx="3.8" ry="9" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5 A4.6 4.6 0 0 0 17 14 L20 11 A4.6 4.6 0 0 0 13.5 4.5 L12 6" />
      <path d="M14 10.5 A4.6 4.6 0 0 0 7 10 L4 13 A4.6 4.6 0 0 0 10.5 19.5 L12 18" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.5 19.5 L5.3 15.5 L16 4.8 A1.8 1.8 0 0 1 18.5 4.8 L19.2 5.5 A1.8 1.8 0 0 1 19.2 8 L8.5 18.7 Z" />
      <path d="M14 6.8 L17.2 10" />
    </>
  ),
  // A prompt: the chevron and the cursor line.
  terminal: <path d="M5 8 L9 12 L5 16 M12 17 H19" />,
  // Source control: a trunk with two nodes, and a second node whose line bends
  // back into the trunk's end.
  'git-branch': (
    <>
      <circle cx="7" cy="5.5" r="2.5" />
      <circle cx="7" cy="18.5" r="2.5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M7 8 V16" />
      <path d="M17 11.5 V12.5 A3.5 3.5 0 0 1 13.5 16 H7" />
    </>
  ),
  // A speech bubble with its tail at the lower left: a review comment.
  comment: (
    <path d="M5.5 4.5 H18.5 A2 2 0 0 1 20.5 6.5 V14.5 A2 2 0 0 1 18.5 16.5 H11 L7 20.5 V16.5 H5.5 A2 2 0 0 1 3.5 14.5 V6.5 A2 2 0 0 1 5.5 4.5 Z" />
  ),

  // ── Transfer, navigation, direction ──
  upload: (
    <>
      <path d="M12 15.5 V4.5" />
      <path d="M7.5 9 L12 4.5 L16.5 9" />
      <path d="M4.5 15 V18 A1.5 1.5 0 0 0 6 19.5 H18 A1.5 1.5 0 0 0 19.5 18 V15" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5 V15.5" />
      <path d="M7.5 11 L12 15.5 L16.5 11" />
      <path d="M4.5 15 V18 A1.5 1.5 0 0 0 6 19.5 H18 A1.5 1.5 0 0 0 19.5 18 V15" />
    </>
  ),
  // An arrow leaving a box: open this somewhere else.
  external: (
    <>
      <path d="M13.5 4.5 H19.5 V10.5" />
      <path d="M19.5 4.5 L11 13" />
      <path d="M17 14 V18 A1.5 1.5 0 0 1 15.5 19.5 H6 A1.5 1.5 0 0 1 4.5 18 V8.5 A1.5 1.5 0 0 1 6 7 H10" />
    </>
  ),
  // ↩ — a hook arrow: go back up a level (not ←, which is `arrow-left`).
  back: (
    <>
      <path d="M8.5 5 L4 9.5 L8.5 14" />
      <path d="M4 9.5 H15 A4.75 4.75 0 0 1 15 19 H10" />
    </>
  ),
  // ↶ — a corner head with a curved lead into a half-turn: take the last action
  // back. Not `back`, whose straight lead means "up a level".
  undo: (
    <>
      <path d="M5 7.5 V13 H10.5" />
      <path d="M5 13 C6.5 9.5 9.5 8 13 8 A5.75 5.75 0 0 1 13 19.5 H9" />
    </>
  ),
  'arrow-left': (
    <>
      <path d="M19 12 H5" />
      <path d="M11 6 L5 12 L11 18" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M5 12 H19" />
      <path d="M13 6 L19 12 L13 18" />
    </>
  ),
  'arrow-up': (
    <>
      <path d="M12 19 V5" />
      <path d="M6 11 L12 5 L18 11" />
    </>
  ),
  'arrow-down': (
    <>
      <path d="M12 5 V19" />
      <path d="M6 13 L12 19 L18 13" />
    </>
  ),
  'chevron-left': <path d="M14.5 6 L8.5 12 L14.5 18" />,
  'chevron-right': <path d="M9.5 6 L15.5 12 L9.5 18" />,
  'chevron-up': <path d="M6 14.5 L12 8.5 L18 14.5" />,
  'chevron-down': <path d="M6 9.5 L12 15.5 L18 9.5" />,

  // ── Controls and state ──
  'checkbox-on': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 12.5 L11 15.5 L16.5 9" />
    </>
  ),
  'checkbox-off': <rect x="4" y="4" width="16" height="16" rx="3" />,
  play: <path d="M7 4.5 L19 12 L7 19.5 Z" />,
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  // Solid, larger than `dot`: the recording indicator (the 🔴 it replaces).
  record: <circle cx="12" cy="12" r="7" fill="currentColor" stroke="none" />,
  // Solid, small: a status mark (unsaved changes) that sits beside a label.
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M3.5 16.5 L8.5 12 L13 16 L16 13.5 L20.5 17.5" />
    </>
  ),
  plus: <path d="M12 5 V19 M5 12 H19" />,
  // ⏏ — a triangle over a bar: take this out of the split.
  eject: (
    <>
      <path d="M12 5 L19 14 H5 Z" />
      <path d="M5 18.5 H19" />
    </>
  ),
  // ⏳ — two wedges meeting at the waist, capped top and bottom.
  hourglass: (
    <>
      <path d="M7 3.5 H17 M7 20.5 H17" />
      <path d="M8 3.5 V7 L12 12 L8 17 V20.5" />
      <path d="M16 3.5 V7 L12 12 L16 17 V20.5" />
    </>
  ),
  reload: (
    <>
      <path d="M19.5 12.5 A7.5 7.5 0 1 1 17.3 7.2" />
      <path d="M19.5 4 V8.5 H15" />
    </>
  ),
  // The back sheet shows only its top and left edge; the front sheet covers the rest.
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 15 H5 A1.5 1.5 0 0 1 3.5 13.5 V5 A1.5 1.5 0 0 1 5 3.5 H13.5 A1.5 1.5 0 0 1 15 5 V6" />
    </>
  ),

  // ── Surfaces: what the dock rail and the mobile drawer switch between ──
  // A gear: eight trapezoid teeth around a hub. The tips and roots are arcs of two
  // circles (radius 9.5 and 7) about the centre, so the outline stays round at 16px.
  settings: (
    <>
      <path d="M10.66 5.13 L10.76 2.58 A9.5 9.5 0 0 1 13.24 2.58 L13.34 5.13 A7 7 0 0 1 15.91 6.2 L17.78 4.46 A9.5 9.5 0 0 1 19.54 6.22 L17.8 8.09 A7 7 0 0 1 18.87 10.66 L21.42 10.76 A9.5 9.5 0 0 1 21.42 13.24 L18.87 13.34 A7 7 0 0 1 17.8 15.91 L19.54 17.78 A9.5 9.5 0 0 1 17.78 19.54 L15.91 17.8 A7 7 0 0 1 13.34 18.87 L13.24 21.42 A9.5 9.5 0 0 1 10.76 21.42 L10.66 18.87 A7 7 0 0 1 8.09 17.8 L6.22 19.54 A9.5 9.5 0 0 1 4.46 17.78 L6.2 15.91 A7 7 0 0 1 5.13 13.34 L2.58 13.24 A9.5 9.5 0 0 1 2.58 10.76 L5.13 10.66 A7 7 0 0 1 6.2 8.09 L4.46 6.22 A9.5 9.5 0 0 1 6.22 4.46 L8.09 6.2 A7 7 0 0 1 10.66 5.13 Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // A list with markers: the tab list, as distinct from `menu`'s bare bars.
  sessions: (
    <path d="M9 6.5 H20 M9 12 H20 M9 17.5 H20 M4.5 6.5 H4.51 M4.5 12 H4.51 M4.5 17.5 H4.51" />
  ),
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  // Two panes side by side.
  split: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M12 4.5 V19.5" />
    </>
  ),
  // The split's rotate handle. Named for the orientation the split is IN, drawn as
  // the direction it will move to: a row (side by side) offers the vertical double
  // arrow, a column (stacked) the horizontal one — the same pairing the ⬍/⬌ glyphs had.
  'rotate-row': (
    <>
      <path d="M12 4 V20" />
      <path d="M8 8 L12 4 L16 8" />
      <path d="M8 16 L12 20 L16 16" />
    </>
  ),
  'rotate-col': (
    <>
      <path d="M4 12 H20" />
      <path d="M8 8 L4 12 L8 16" />
      <path d="M16 8 L20 12 L16 16" />
    </>
  ),
} satisfies Record<string, ReactNode>;

/** The registered icon names. */
export type IconId = keyof typeof GLYPHS;

// `in` would also match `constructor`/`toString`, so a config asking for
// `"icon": "constructor"` would have drawn a function; an own-key check cannot.
const isIconId = (name: string): name is IconId => Object.hasOwn(GLYPHS, name);

/** Every registered name. `extra-keys.json`'s `"icon"` accepts any of them. */
export const ICON_NAMES: readonly IconId[] = Object.keys(GLYPHS).filter(isIconId);

/** A registered icon, or nothing for a name this client does not know — a
 *  config-supplied name must degrade to its text label, never draw a blank box. */
export function Icon({ name, size = 16 }: { name: string; size?: number }): ReactNode {
  return isIconId(name) ? <IconFrame size={size}>{GLYPHS[name]}</IconFrame> : null;
}

/** The icon for a name, or null. Unlike `<Icon>` this must answer null ITSELF, not
 *  an element that renders nothing: the extra-keys bar reads `namedIcon(x) ?? label`,
 *  and an element is non-null, so an unknown name would have swallowed the label. */
export function namedIcon(name: string | undefined): ReactNode | null {
  return name && isIconId(name) ? <Icon name={name} /> : null;
}
