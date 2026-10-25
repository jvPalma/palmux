// ── Which Explorer roots are open, per device ─────────────────────────────────
//
// The Explorer's sections (HOME and each pinned folder) used to open fresh on
// every mount, and HOME was forced open on arrival, so closing the dock's view
// forgot everything. The set of OPEN roots now lives in `localStorage`.
//
// It is per-device view state and never goes to the server, unlike the pins
// themselves: a pin is a path on the server's filesystem and is right on every
// device, but whether a section is open is a preference of the screen in front of
// you. A synced copy would make a phone's collapsed HOME close the desktop's.
//
// `null` from the reader means "nothing stored", which is NOT the same as an
// empty set: the first is a device's first run (HOME opens), the second is a
// person who collapsed everything.
//
// Nothing here throws. Storage can be unavailable (private mode) or hold
// anything at all, and an Explorer that failed to render over a view preference
// would be a poor trade.

import { normalizePin } from './explorer-pins';

export const OPEN_ROOTS_KEY = 'palmux-explorer-open';

/** Parse a stored value, or null for anything unusable. Never throws. */
export function parseOpenRoots(raw: string | null): string[] | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { v, open } = value as Record<string, unknown>;
  if (v !== 1 || !Array.isArray(open)) return null;
  const out: string[] = [];
  for (const entry of open) {
    if (typeof entry !== 'string') continue;
    // Normalised the way the roots are, so a hand-edited `/work/` still matches
    // the `/work` root. A relative path comes back empty and is dropped.
    const path = normalizePin(entry);
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

export function serializeOpenRoots(open: Iterable<string>): string {
  return JSON.stringify({ v: 1, open: [...open] });
}

/** This device's remembered open roots, or null when nothing usable is stored. */
export function readOpenRoots(): string[] | null {
  try {
    return parseOpenRoots(localStorage.getItem(OPEN_ROOTS_KEY));
  } catch {
    return null; // storage unavailable — the caller treats it as a first run
  }
}

/** Remember the open roots on this device. Best-effort. */
export function writeOpenRoots(open: Iterable<string>): void {
  try {
    localStorage.setItem(OPEN_ROOTS_KEY, serializeOpenRoots(open));
  } catch {
    /* storage unavailable or full — the Explorer simply forgets on reload */
  }
}
