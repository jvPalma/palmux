// ── Which tab THIS window is looking at ───────────────────────────────────────
//
// The URL used to be the answer: the path WAS the active tab, so switching tabs
// was a browser navigation. That stopped paying once a tab could be a web page,
// a note or a file on disk — `/2` for `package.json` describes nothing — and it
// cost something concrete: a web pane's ← walks the same history stack the tab
// strip pushed into, so back could undo a tab switch instead of navigating the
// framed page.
//
// Selection lives in `sessionStorage`, which is scoped to ONE browsing context.
// That is the point: two browser windows on the same palmux hold independent
// selections, so one window never yanks the other. The tab LIST is unaffected and
// stays server state, shared by every window; only "which one am I looking at" is
// local.
//
// `sessionStorage` alone has one cost, and an installed PWA pays it on every
// launch: its window is a browsing context the OS ends whenever it likes (Android
// kills it freely), so the next launch had no selection and opened the first tab.
// So the device's most recently SELECTED tab is kept in `localStorage` as well,
// and a window reads it ONLY when it has no selection of its own — a fresh window
// or a relaunched PWA. That preserves the rule above: an open window's own value
// always wins, so the shared one can never move a window that is already showing
// something. The price, taken on purpose: a second window opened later starts on
// whatever was selected last anywhere on this device.
//
// Who WRITES the shared value matters as much as who reads it, and that is App's
// decision, not this module's. It may write only when a window's selection really
// changes — never because a tab-list or title broadcast re-ran the persist effect,
// or a window that merely heard a rename would overwrite the tab another window
// just chose. A detached window writes neither value: it keeps its selection under a key of its
// own (`palmux-window-tab:<wid>`) and never reads the device's copy, because `window.open` may
// have copied the opener's storage and the device's last tab is whatever a MAIN window chose.
//
// Nothing here throws. Storage can be unavailable (private mode, storage
// disabled) or hold anything at all, and a terminal that refuses to load because
// it could not remember a tab number would be a poor trade.

import { isTabKind, type TabKind, type TabMeta } from '@palmux/shared';

const KEY = 'palmux-window-tab';

/** The storage key of a window's own selection: the main window's, or a detached window's (`wid`). */
const keyFor = (wid: string | null): string => (wid ? `${KEY}:${wid}` : KEY);

/** The device-wide copy: the tab most recently selected in ANY window here. */
export const LAST_TAB_KEY = 'palmux-last-tab';

/**
 * The stored selection.
 *
 * The KIND rides along because ids are recycled lowest-free: a stored `2` can
 * come back as a different kind of tab entirely, and restoring "tab 2" would
 * then open a stranger. This is the same defence `reconcilePairings` already
 * applies to split slots.
 */
export interface WindowSelection {
  id: string;
  kind: TabKind;
}

/** Parse a stored value, or null for anything unusable. Never throws. */
export function parseSelection(raw: string | null): WindowSelection | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return typeof v['id'] === 'string' && v['id'] && isTabKind(v['kind'])
      ? { id: v['id'], kind: v['kind'] }
      : null;
  } catch {
    return null;
  }
}

/** This window's own remembered selection, or null. */
function readOwnSelection(wid: string | null): WindowSelection | null {
  try {
    return parseSelection(sessionStorage.getItem(keyFor(wid)));
  } catch {
    return null; // storage unavailable — fall through to the device-wide value
  }
}

/** The device's last selected tab, or null. */
export function readLastTab(): WindowSelection | null {
  try {
    return parseSelection(localStorage.getItem(LAST_TAB_KEY));
  } catch {
    return null; // storage unavailable — the caller falls back to the first tab
  }
}

/**
 * The selection to boot from: this window's own, else the device's last one.
 *
 * "Own" means usable — an unparsable `sessionStorage` value is the same as none,
 * so a window with a corrupt value still comes back on the last tab and not on
 * the first.
 *
 * A detached window (`wid`) answers its own key and nothing else: the device's last tab is
 * whatever a main window chose, and the main window's key may be a copy `window.open` made.
 */
export function readSelection(wid: string | null = null): WindowSelection | null {
  return wid ? readOwnSelection(wid) : (readOwnSelection(null) ?? readLastTab());
}

/** Remember a selection for this window only. Best-effort. */
export function writeSelection(sel: WindowSelection | null, wid: string | null = null): void {
  try {
    if (sel) sessionStorage.setItem(keyFor(wid), JSON.stringify(sel));
    else sessionStorage.removeItem(keyFor(wid));
  } catch {
    /* storage unavailable — the window simply forgets on reload */
  }
}

/**
 * Remember a selection for this DEVICE. Best-effort, and never clears.
 *
 * Deliberately a different function from `writeSelection`: that one runs on every
 * tab-list broadcast and is idempotent, this one is only safe on a real change
 * (see the header). It takes no `null` — a window with nothing selected has no
 * opinion to store, and the previous value stays the best answer for a relaunch.
 */
export function writeLastTab(sel: WindowSelection): void {
  try {
    localStorage.setItem(LAST_TAB_KEY, JSON.stringify(sel));
  } catch {
    /* storage unavailable — a relaunch simply opens the first tab */
  }
}

export interface ResolveInput {
  /** What this window (or, failing that, this device) remembered, if anything. */
  stored: WindowSelection | null;
  /** The live tabs, in STRIP order (the broadcast's order is authoritative). */
  tabs: TabMeta[];
}

/**
 * The tab this window should show, or null for the New-tab chooser.
 *
 * Keep the remembered tab if it is still there AND still the same kind; else the
 * FIRST tab in strip order. First in STRIP order, not the lowest id: tab-reorder
 * decoupled display order from id, so "tab 0" can sit anywhere or not exist.
 *
 * This deliberately does NOT implement the neighbour rule, though an earlier
 * draft of the spec asked it to. That rule already has an owner —
 * `workspaceController`'s `sessionsBroadcast` navigates to the left-then-right
 * neighbour when the ACTIVE tab disappears, which is exactly the "another window
 * closed the tab I was on" case and is the one place holding the previous strip
 * order needed to compute it. Implementing it here too would be a second source
 * of truth for the same rule, and this one has no previous order to work from:
 * at boot there is no "before", so a dead stored id has no position to be a
 * neighbour of.
 */
export function resolveSelection({ stored, tabs }: ResolveInput): string | null {
  return resolveStoredSelection(tabs, stored) ?? tabs[0]?.id ?? null;
}

/**
 * The stored selection's id, only when that tab is live AND still the stored kind; else null.
 *
 * `resolveSelection` answers the first tab for an unusable value, which is a guess. A caller that
 * must not override something better (a restored pane layout already knows which tab each pane
 * shows) needs to tell "the window remembered this" from "nothing usable was remembered", and
 * this is the first half of `resolveSelection` without the guess.
 */
export function resolveStoredSelection(
  tabs: TabMeta[],
  stored: WindowSelection | null,
): string | null {
  if (!stored) return null;
  const live = tabs.find((t) => t.id === stored.id);
  return live && live.kind === stored.kind ? stored.id : null;
}

/** The selection to STORE for a chosen id, or null when the tab is unknown. */
export function selectionFor(tabs: TabMeta[], id: string): WindowSelection | null {
  const tab = tabs.find((t) => t.id === id);
  return tab ? { id: tab.id, kind: tab.kind } : null;
}
