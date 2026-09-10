// ── Extra-key glyph icons ─────────────────────────────────────────────────────
//
// Crisp SVG faces for the extra-keys toolbar, so directional/edit keys read as
// icons instead of tiny words (UP/DOWN/LEFT/RIGHT/TAB) and low-contrast symbols
// (- ~ /) render large and legible. Modifier/word keys (CTRL/ALT/SHIFT/ESC) keep
// their text labels — only the keys mapped here get an icon; everything else
// falls back to the text label in ExtraKeysBar.
//
// Keyed by the extra-key's send-id (uppercased key name, or the literal symbol),
// so it works for both the default layout and any Termux config using the same
// tokens.

import type { ReactNode } from 'react';

// Shared SVG wrapper — inherits color via currentColor; sized by CSS (`.ek-key svg`).
const Icon = ({ children, w = 2 }: { children: ReactNode; w?: number }): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={w}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

// A line-plus-chevron arrow; `d` is the shaft, `head` the arrowhead path.
const ARROWS: Record<string, ReactNode> = {
  ARROWLEFT: (
    <Icon>
      <path d="M20 12 H6" />
      <path d="M11 7 L6 12 L11 17" />
    </Icon>
  ),
  ARROWRIGHT: (
    <Icon>
      <path d="M4 12 H18" />
      <path d="M13 7 L18 12 L13 17" />
    </Icon>
  ),
  ARROWUP: (
    <Icon>
      <path d="M12 20 V6" />
      <path d="M7 11 L12 6 L17 11" />
    </Icon>
  ),
  ARROWDOWN: (
    <Icon>
      <path d="M12 4 V18" />
      <path d="M7 13 L12 18 L17 13" />
    </Icon>
  ),
};

// Termux key names → the arrow id above (the toolbar sends UP/DOWN/LEFT/RIGHT).
const ARROW_ALIASES: Record<string, string> = {
  UP: 'ARROWUP',
  DOWN: 'ARROWDOWN',
  LEFT: 'ARROWLEFT',
  RIGHT: 'ARROWRIGHT',
  ARROWUP: 'ARROWUP',
  ARROWDOWN: 'ARROWDOWN',
  ARROWLEFT: 'ARROWLEFT',
  ARROWRIGHT: 'ARROWRIGHT',
};

const FACES: Record<string, ReactNode> = {
  // Tab: an arrow into a bar (⇥).
  TAB: (
    <Icon>
      <path d="M3 12 H15" />
      <path d="M11 8 L15 12 L11 16" />
      <path d="M19 6 V18" />
    </Icon>
  ),
  // Low-contrast symbols, drawn bold so they're legible at a glance.
  '-': (
    <Icon w={2.6}>
      <path d="M5 12 H19" />
    </Icon>
  ),
  '/': (
    <Icon w={2.6}>
      <path d="M17 5 L7 19" />
    </Icon>
  ),
  '~': (
    <Icon w={2.6}>
      <path d="M4 14 C6.5 9.5 9 9.5 12 12 C15 14.5 17.5 14.5 20 10" />
    </Icon>
  ),
};

/**
 * The SVG face for an extra-key send-id, or null when the key should keep its
 * text label (CTRL/ALT/SHIFT/ESC/ENTER/… and any unmapped token).
 */
export function keyFace(id: string): ReactNode | null {
  if (!id) return null;
  const up = id.toUpperCase();
  const arrow = ARROW_ALIASES[up];
  if (arrow) return ARROWS[arrow];
  return FACES[up] ?? FACES[id] ?? null;
}
