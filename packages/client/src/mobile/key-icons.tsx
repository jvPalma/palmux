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
import { IconFrame, ICON_NAMES, namedIcon } from '../ui/icons';

// The SVG frame is the app-wide one (`ui/icons.tsx`) — inherits color via
// currentColor, sized by CSS here (`.ek-key svg`). One stroke weight for every
// face: the symbols used to be drawn at 2.6 to read "at a glance", and on a real
// phone that made `-` `~` `/` the heaviest marks on the bar, louder than the
// labels beside them.

// A line-plus-chevron arrow; `d` is the shaft, `head` the arrowhead path.
const ARROWS: Record<string, ReactNode> = {
  ARROWLEFT: (
    <IconFrame>
      <path d="M20 12 H6" />
      <path d="M11 7 L6 12 L11 17" />
    </IconFrame>
  ),
  ARROWRIGHT: (
    <IconFrame>
      <path d="M4 12 H18" />
      <path d="M13 7 L18 12 L13 17" />
    </IconFrame>
  ),
  ARROWUP: (
    <IconFrame>
      <path d="M12 20 V6" />
      <path d="M7 11 L12 6 L17 11" />
    </IconFrame>
  ),
  ARROWDOWN: (
    <IconFrame>
      <path d="M12 4 V18" />
      <path d="M7 13 L12 18 L17 13" />
    </IconFrame>
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
    <IconFrame>
      <path d="M4 12 H15" />
      <path d="M11.5 8.5 L15 12 L11.5 15.5" />
      <path d="M19 7 V17" />
    </IconFrame>
  ),
  '-': (
    <IconFrame>
      <path d="M7 12 H17" />
    </IconFrame>
  ),
  '/': (
    <IconFrame>
      <path d="M15 5 L9 19" />
    </IconFrame>
  ),
  '~': (
    <IconFrame>
      <path d="M5 13.5 C7 10 9.5 10 12 12 C14.5 14 17 14 19 10.5" />
    </IconFrame>
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

// Named icons a config can ask for with `"icon": "<name>"` — for macro and
// action keys, whose text label would be a chord nobody can read. The registry is
// the shared one in `ui/icons.tsx`, so every name there works here too, and each
// also works as a corner hint (a popup's `icon`, an action's glyph).

/** The names `"icon"` accepts in extra-keys.json. */
export const KEY_ICON_NAMES = ICON_NAMES;

export { namedIcon };
