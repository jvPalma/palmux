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
// The FOLDERS a user opened inside those roots are remembered the same way, under
// a second key (`palmux-explorer-expanded`). A root is a section header and a
// folder is a row; the two used to share one in-memory set, which is why a nested
// pin's folder row could not be told apart from its section. They stay separate
// here too, so neither can rewrite the other.
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

export const EXPANDED_DIRS_KEY = 'palmux-explorer-expanded';

/**
 * How many expanded folders are remembered, newest kept.
 *
 * The bound is the only thing that forgets a stale record: a folder is dropped
 * when the Explorer deletes it, and nowhere else, because no listing is proof of
 * absence (the route answers a transient failure as 404 and silently omits an
 * entry it could not `lstat`). A folder removed from the terminal therefore stays
 * stored until newer ones push it out. It costs no request meanwhile: a stored folder
 * is fetched only when its parent's listing shows it (`neededDirs` in FileTree).
 */
export const MAX_EXPANDED_DIRS = 200;

const capNewest = (dirs: readonly string[]): string[] => dirs.slice(-MAX_EXPANDED_DIRS);

/**
 * Parse the stored folders, oldest first, or [] for anything unusable.
 *
 * Total, unlike `parseOpenRoots`: there is no first run to tell apart from "nothing
 * expanded", so a missing value and an empty one are the same Explorer.
 */
export function parseExpandedDirs(raw: string | null): string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof value !== 'object' || value === null) return [];
  const { v, dirs } = value as Record<string, unknown>;
  if (v !== 1 || !Array.isArray(dirs)) return [];
  const out: string[] = [];
  for (const entry of dirs) {
    if (typeof entry !== 'string') continue;
    // Normalised like the roots, so a hand-edited `/work/` matches the tree's `/work`.
    const path = normalizePin(entry);
    if (path && !out.includes(path)) out.push(path);
  }
  return capNewest(out);
}

export function serializeExpandedDirs(dirs: Iterable<string>): string {
  return JSON.stringify({ v: 1, dirs: capNewest([...dirs]) });
}

/** This device's remembered expanded folders, oldest first. */
export function readExpandedDirs(): string[] {
  try {
    return parseExpandedDirs(localStorage.getItem(EXPANDED_DIRS_KEY));
  } catch {
    return []; // storage unavailable — the Explorer opens with every folder closed
  }
}

/** Remember the expanded folders on this device. Best-effort. */
export function writeExpandedDirs(dirs: Iterable<string>): void {
  try {
    localStorage.setItem(EXPANDED_DIRS_KEY, serializeExpandedDirs(dirs));
  } catch {
    /* storage unavailable or full — the Explorer simply forgets on reload */
  }
}

// The tree's WRITES go through the two functions below and never through
// `writeExpandedDirs` with a mount's own copy. More than one FileTree can be alive
// (the dock and the drawer, two windows), and a delete can finish after the tree
// that sent it has unmounted, so any one mount's memory may be stale: storing it
// whole would erase what another mount opened meanwhile. Each write is therefore
// ONE change applied to what is stored now.
//
// That is a read, a change and a write with no lock between them: Web Storage has no
// cross-window locking, so two windows of ONE device changing expansion in the same
// instant can overwrite each other. A lock was rejected (it makes the write
// asynchronous, which opens a remount race, and a mounted tree in another window would
// still need a delete transport). The consequences are bounded instead, and written
// down in CLAUDE.md (Explorer persistence): a stale record is never fetched, and a
// lost collapse reopens its folder on the next mount.

/** Strictly inside `root`, compared by path segment and not by string prefix. */
export const isUnder = (path: string, root: string): boolean =>
  path !== root && path.startsWith(root === '/' ? '/' : `${root}/`);

/** `dirs` minus each deleted path and everything under it, order kept. */
export function withoutDeleted(dirs: Iterable<string>, gone: readonly string[]): string[] {
  return [...dirs].filter((dir) => !gone.some((path) => dir === path || isUnder(dir, path)));
}

/** Open or close ONE folder in what is stored now. A fresh open goes last, which is
 *  what makes the cap drop the oldest; closing leaves its descendants stored. */
export function writeExpandedDir(dir: string, open: boolean): void {
  // The same identity the parse restores, so a spelling of a folder that is already
  // stored replaces its record instead of adding a second one.
  const path = normalizePin(dir);
  if (!path) return;
  const dirs = readExpandedDirs().filter((d) => d !== path);
  if (open) dirs.push(path);
  writeExpandedDirs(dirs);
}

type DeletedListener = (gone: readonly string[]) => void;
const deletedListeners = new Set<DeletedListener>();

/** Hear every delete the Explorer completes, whichever tree sent it. Returns the
 *  unsubscribe, for the tree's unmount. */
export function subscribeDeletedDirs(listener: DeletedListener): () => void {
  deletedListeners.add(listener);
  return () => {
    deletedListeners.delete(listener);
  };
}

/**
 * The Explorer deleted `gone`: forget those folders and every one under them, in
 * storage as it is now and in every mounted tree.
 *
 * The trees are told, not just the storage, because a tree that mounted while the
 * delete was in flight read the folder from storage and still holds it open — and
 * the tree that sent the delete may be gone. Told even when storage is unavailable:
 * the folder is no less deleted.
 */
export function forgetDeletedDirs(deleted: readonly string[]): void {
  // Canonical, because the records and every tree's set are: a delete that came back
  // in another spelling must still match the folder it removed.
  const gone = deleted.map(normalizePin).filter(Boolean);
  if (gone.length === 0) return;
  const stored = readExpandedDirs();
  const kept = withoutDeleted(stored, gone);
  if (kept.length !== stored.length) writeExpandedDirs(kept);
  for (const listener of deletedListeners) listener(gone);
}
