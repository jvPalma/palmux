// ── The last discard of each project, for the project bar's Undo ──────────────
//
// A discard cannot be taken back from the 6-second toast alone: the work it
// removed can be larger than anyone notices in six seconds. So the latest discard
// of each project is also kept here for `DISCARD_UNDO_MS`, and the project bar
// offers Undo while it lasts. LATEST ONLY, on purpose: a list would need ordering
// rules between discards of overlapping files, and the server's compare-and-swap
// already refuses the stale ones.
//
// Per-device view state in `localStorage`, like the Explorer's open roots: the
// receipt is the server's, but which window offers it is the screen in front of you.
// `subscribeDiscards` also hears the `storage` event, so two windows of one device
// agree on whether the button is there.
//
// Nothing here throws. Storage can be unavailable or hold anything at all, and a
// project bar that failed to render over a convenience would be a poor trade.

export const LAST_DISCARD_KEY = 'palmux-scm-last-discard';

/** How long a discard stays undoable from the project bar: ten minutes. */
export const DISCARD_UNDO_MS = 600_000;

export interface LastDiscard {
  receiptId: string;
  /** When it was made, in `Date.now()` milliseconds. */
  at: number;
  /** Files the discard changed, for the button's label. */
  count: number;
}

// A Map, not an object: a project path is untrusted text and `__proto__` must stay a key.
type Store = Map<string, LastDiscard>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Parse a stored value; anything unusable reads as empty, and one bad entry loses only itself. */
function parse(raw: string | null): Store {
  const out: Store = new Map();
  if (!raw) return out;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(value) || value['v'] !== 1 || !isRecord(value['byRepo'])) return out;
  for (const [top, entry] of Object.entries(value['byRepo'])) {
    if (
      isRecord(entry) &&
      typeof entry['receiptId'] === 'string' &&
      entry['receiptId'] !== '' &&
      typeof entry['at'] === 'number' &&
      Number.isFinite(entry['at']) &&
      typeof entry['count'] === 'number' &&
      Number.isFinite(entry['count'])
    ) {
      out.set(top, { receiptId: entry['receiptId'], at: entry['at'], count: entry['count'] });
    }
  }
  return out;
}

function load(): Store {
  try {
    return parse(localStorage.getItem(LAST_DISCARD_KEY));
  } catch {
    return new Map(); // storage unavailable
  }
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function save(store: Store): void {
  try {
    localStorage.setItem(
      LAST_DISCARD_KEY,
      JSON.stringify({ v: 1, byRepo: Object.fromEntries(store) }),
    );
  } catch {
    /* storage unavailable or full: the Undo button is simply not offered */
  }
  notify();
}

/** The project's last discard while it is younger than the Undo window, else null. */
export function readLastDiscard(top: string, now: number = Date.now()): LastDiscard | null {
  const entry = load().get(top);
  if (entry === undefined || now - entry.at >= DISCARD_UNDO_MS) return null;
  return entry;
}

/** Remember a discard as the project's latest, replacing the one before it. */
export function recordDiscard(top: string, discard: LastDiscard): void {
  save(load().set(top, discard));
}

/**
 * Forget the project's entry, but only when it is still `receiptId`: a newer discard
 * made meanwhile must not be forgotten by the Undo of an older one.
 */
export function forgetDiscard(top: string, receiptId: string): void {
  const store = load();
  if (store.get(top)?.receiptId !== receiptId) return;
  store.delete(top);
  save(store);
}

/** Call `cb` after a change made here or by another window of this device. */
export function subscribeDiscards(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (event: StorageEvent): void => {
    // A null key is `localStorage.clear()`.
    if (event.key === LAST_DISCARD_KEY || event.key === null) cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}
