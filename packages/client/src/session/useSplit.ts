// ── Split layout state ────────────────────────────────────────────────────────
//
// Multi-pairing desktop split: a PAIRING is one SplitState (two tabs,
// orientation, divider ratio, focus). Any number of independent pairings coexist;
// each tab belongs to at most one. A pairing's stable KEY is its slot-A tab id
// (unique across pairings; a.tabId !== b.tabId). Persisted per device
// (localStorage 'palmux-splits' v2), desktop-only (never while the mobile layer
// is active). Pure helpers (rects, reconcile, persistence parse) are exported for
// testing; the hook is a thin stateful wrapper.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TabKind, TabMeta } from '@palmux/shared';

export type Orientation = 'row' | 'column';
export type SlotId = 'a' | 'b';

export interface SlotRef {
  tabId: string;
  kind: TabKind;
}

export interface SplitState {
  a: SlotRef;
  b: SlotRef;
  orientation: Orientation;
  /** Slot A's fraction of the container, clamped 0.15–0.85. */
  ratio: number;
  focused: SlotId;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const STORE_KEY = 'palmux-splits';
/** The retired single-pairing blob — read once for migration, never written. */
const LEGACY_KEY = 'palmux-split';
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export const clampRatio = (r: number): number =>
  Number.isFinite(r) ? Math.max(MIN_RATIO, Math.min(MAX_RATIO, r)) : 0.5;

/** Percent rects (0–100) for the two slots given orientation + ratio. */
export function splitRects(orientation: Orientation, ratio: number): { a: Rect; b: Rect } {
  const r = clampRatio(ratio) * 100;
  if (orientation === 'row') {
    return {
      a: { left: 0, top: 0, width: r, height: 100 },
      b: { left: r, top: 0, width: 100 - r, height: 100 },
    };
  }
  return {
    a: { left: 0, top: 0, width: 100, height: r },
    b: { left: 0, top: r, width: 100, height: 100 - r },
  };
}

const FULL: Rect = { left: 0, top: 0, width: 100, height: 100 };
export const fullRect = (): Rect => ({ ...FULL });

function isKind(v: unknown): v is TabKind {
  return v === 'terminal' || v === 'web' || v === 'dashboard' || v === 'editor' || v === 'markdown';
}

function slotOf(s: unknown): SlotRef | null {
  if (typeof s !== 'object' || s === null) return null;
  const r = s as Record<string, unknown>;
  return typeof r['tabId'] === 'string' && isKind(r['kind'])
    ? { tabId: r['tabId'], kind: r['kind'] }
    : null;
}

/** Validate one already-parsed pairing object, or null if unusable. */
function splitStateOf(v: unknown): SplitState | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const a = slotOf(o['a']);
  const b = slotOf(o['b']);
  if (!a || !b || a.tabId === b.tabId) return null;
  const orientation: Orientation = o['orientation'] === 'column' ? 'column' : 'row';
  const focused: SlotId = o['focused'] === 'b' ? 'b' : 'a';
  return { a, b, orientation, ratio: clampRatio(Number(o['ratio'])), focused };
}

/** Parse the legacy single-pairing blob, or null if unusable (forgiving). */
export function parseSplit(raw: string | null): SplitState | null {
  if (!raw) return null;
  try {
    return splitStateOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Keep each tab in at most one pairing — later duplicates dropped. */
function dedupePairings(list: SplitState[]): SplitState[] {
  const seen = new Set<string>();
  const out: SplitState[] = [];
  for (const p of list) {
    if (seen.has(p.a.tabId) || seen.has(p.b.tabId)) continue;
    seen.add(p.a.tabId);
    seen.add(p.b.tabId);
    out.push(p);
  }
  return out;
}

/**
 * Parse the v2 pairings store (structurally valid → its entries, per-entry
 * forgiving, even when empty), or null when it's null / not a v2 blob so the
 * caller can fall back to the legacy single-pairing key.
 */
function parseV2(raw: string | null): SplitState[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (o['v'] !== 2 || !Array.isArray(o['pairings'])) return null;
    const out: SplitState[] = [];
    for (const entry of o['pairings']) {
      const p = splitStateOf(entry);
      if (p) out.push(p);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Parse persisted pairings. Prefers the v2 store; when it's absent or malformed
 * falls back to the legacy single-pairing blob (never deleted or rewritten).
 * Forgiving per entry and enforces at-most-one-pairing-per-tab.
 */
export function parsePairings(raw: string | null, legacyRaw: string | null): SplitState[] {
  const v2 = parseV2(raw);
  if (v2) return dedupePairings(v2);
  const legacy = parseSplit(legacyRaw);
  return legacy ? [legacy] : [];
}

/** The slot holding `id` within a single pairing, or null. */
export function memberSlot(pairing: SplitState, id: string): SlotId | null {
  return pairing.a.tabId === id ? 'a' : pairing.b.tabId === id ? 'b' : null;
}

/** The pairing that contains `id`, or null. */
export function pairingOf(pairings: SplitState[], id: string): SplitState | null {
  return pairings.find((p) => p.a.tabId === id || p.b.tabId === id) ?? null;
}

export interface DissolvedPairing {
  key: string;
  survivor: string | null;
}

export interface ReconcileResult {
  pairings: SplitState[];
  dissolved: DissolvedPairing[];
}

type SlotState = 'present' | 'fresh' | 'dead';

/**
 * Reconcile every pairing against the live tabs.
 *
 * Per slot: `present` (in tabs with matching kind), `dead` (absent seen-terminal /
 * absent non-terminal / kind mismatch on a recycled id), or `fresh` (an absent
 * terminal id never yet seen — a just-created slot whose broadcast hasn't landed).
 *
 * A pairing dissolves when either slot is dead (survivor = the live tab, or null
 * when both are dead — nobody navigates). With BOTH slots present it must also
 * stay adjacent (strip indices differ by 1) and share group membership; failing
 * either dissolves it with survivor null (both alive). A fresh slot skips the
 * adjacency/membership check (its position isn't known yet).
 *
 * `pendingAdjacency` keys pairings whose adjacency the app is still ESTABLISHING
 * (a self-split's fresh terminal materializes at the strip end, then gets
 * reordered next to its anchor) — those skip the adjacency/membership dissolve
 * (liveness still applies) so the first broadcast can't kill a newborn pairing.
 *
 * Returns the SAME `pairings` reference when nothing dissolved.
 */
export function reconcilePairings(
  pairings: SplitState[],
  tabs: TabMeta[],
  seenTermIds: ReadonlySet<string>,
  groupOf: (id: string) => string | undefined,
  pendingAdjacency: ReadonlySet<string> = new Set(),
): ReconcileResult {
  const classify = (ref: SlotRef): SlotState => {
    const t = tabs.find((x) => x.id === ref.tabId);
    if (t) return t.kind === ref.kind ? 'present' : 'dead';
    return ref.kind === 'terminal' && !seenTermIds.has(ref.tabId) ? 'fresh' : 'dead';
  };

  const kept: SplitState[] = [];
  const dissolved: DissolvedPairing[] = [];

  for (const p of pairings) {
    const aS = classify(p.a);
    const bS = classify(p.b);
    const aDead = aS === 'dead';
    const bDead = bS === 'dead';

    if (aDead && bDead) {
      dissolved.push({ key: p.a.tabId, survivor: null });
      continue;
    }
    if (aDead) {
      dissolved.push({ key: p.a.tabId, survivor: p.b.tabId });
      continue;
    }
    if (bDead) {
      dissolved.push({ key: p.a.tabId, survivor: p.a.tabId });
      continue;
    }

    // Both alive. A fresh slot has no known position yet — keep the pairing.
    if (aS === 'fresh' || bS === 'fresh') {
      kept.push(p);
      continue;
    }

    // Both present: require adjacency + shared membership — unless the app is
    // still establishing this pairing's adjacency (newborn self-split).
    if (pendingAdjacency.has(p.a.tabId)) {
      kept.push(p);
      continue;
    }
    const ia = tabs.findIndex((x) => x.id === p.a.tabId);
    const ib = tabs.findIndex((x) => x.id === p.b.tabId);
    const adjacent = Math.abs(ia - ib) === 1;
    const sameGroup = groupOf(p.a.tabId) === groupOf(p.b.tabId);
    if (adjacent && sameGroup) {
      kept.push(p);
    } else {
      dissolved.push({ key: p.a.tabId, survivor: null });
    }
  }

  if (dissolved.length === 0) return { pairings, dissolved };
  return { pairings: kept, dissolved };
}

export interface UseSplitResult {
  pairings: SplitState[];
  /**
   * Open a pairing. First removes any existing pairing containing either tab,
   * then appends the new one.
   */
  openSplit: (a: SlotRef, b: SlotRef, orientation: Orientation, focused?: SlotId) => void;
  /** Remove the pairing keyed `key`; returns it (for navigation), or undefined. */
  dissolve: (key: string) => SplitState | undefined;
  setRatio: (key: string, ratio: number) => void;
  toggleOrientation: (key: string) => void;
  focusSlot: (key: string, slot: SlotId) => void;
  /** Trade the two members' sides (ratio kept, focused slot flipped with them). */
  swapSlots: (key: string) => void;
  /** Replace a slot's tab; no-op if the ref is already in this pairing. */
  setSlotTab: (key: string, slot: SlotId, ref: SlotRef) => void;
  /** Replace the whole pairing list (reconcile, drag ops). */
  setPairings: (next: SplitState[]) => void;
  /** Drop every pairing without navigating (e.g. entering mobile mode). */
  clear: () => void;
}

export function useSplit(enabled: boolean): UseSplitResult {
  const [pairings, updatePairings] = useState<SplitState[]>(() =>
    enabled ? parsePairings(localStorage.getItem(STORE_KEY), localStorage.getItem(LEGACY_KEY)) : [],
  );
  const pairingsRef = useRef(pairings);
  pairingsRef.current = pairings;

  // Persist on settle. Desktop-only: never write in mobile. The legacy key is
  // left untouched (read-only migration source).
  useEffect(() => {
    if (!enabled) return;
    try {
      if (pairings.length) localStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, pairings }));
      else localStorage.removeItem(STORE_KEY);
    } catch {
      /* storage full / unavailable — pairings are a discardable view preference */
    }
  }, [pairings, enabled]);

  // Desktop-only: entering mobile drops pairings (kept in storage), leaving mobile
  // restores them — otherwise a mid-session mobileMode toggle would silently lose
  // the split until reload.
  const firstEnabled = useRef(true);
  useEffect(() => {
    if (firstEnabled.current) {
      firstEnabled.current = false; // the useState initializer already loaded them
      return;
    }
    updatePairings(
      enabled
        ? parsePairings(localStorage.getItem(STORE_KEY), localStorage.getItem(LEGACY_KEY))
        : [],
    );
  }, [enabled]);

  const openSplit = useCallback(
    (a: SlotRef, b: SlotRef, orientation: Orientation, focused: SlotId = 'b') => {
      if (a.tabId === b.tabId) return;
      updatePairings((prev) => [
        ...prev.filter(
          (p) =>
            p.a.tabId !== a.tabId &&
            p.b.tabId !== a.tabId &&
            p.a.tabId !== b.tabId &&
            p.b.tabId !== b.tabId,
        ),
        { a, b, orientation, ratio: 0.5, focused },
      ]);
    },
    [],
  );

  const dissolve = useCallback((key: string): SplitState | undefined => {
    const removed = pairingsRef.current.find((p) => p.a.tabId === key);
    if (!removed) return undefined;
    updatePairings((prev) => prev.filter((p) => p.a.tabId !== key));
    return removed;
  }, []);

  const setRatio = useCallback((key: string, ratio: number) => {
    updatePairings((prev) =>
      prev.map((p) => (p.a.tabId === key ? { ...p, ratio: clampRatio(ratio) } : p)),
    );
  }, []);

  const toggleOrientation = useCallback((key: string) => {
    updatePairings((prev) =>
      prev.map((p) =>
        p.a.tabId === key ? { ...p, orientation: p.orientation === 'row' ? 'column' : 'row' } : p,
      ),
    );
  }, []);

  const focusSlot = useCallback((key: string, slot: SlotId) => {
    updatePairings((prev) =>
      prev.map((p) => (p.a.tabId === key && p.focused !== slot ? { ...p, focused: slot } : p)),
    );
  }, []);

  // Trade the two members' sides. The RATIO is deliberately left alone: the
  // divider stays where the user put it and the contents cross it, which is
  // what "swap" means on screen — inverting the ratio too would move each pane
  // back to its own size and nothing would appear to happen.
  //
  // Two consequences worth naming. The pairing's KEY is `a.tabId`, so a swap
  // renames it; every caller derives the key from `pairings` each render, so
  // that is safe, but a key captured across a swap is stale. And `focused` is a
  // SLOT, not a tab — it has to flip as well, or the swap would silently move
  // focus (and the URL) to the other tab.
  const swapSlots = useCallback((key: string) => {
    updatePairings((prev) =>
      prev.map((p) =>
        p.a.tabId === key
          ? { ...p, a: p.b, b: p.a, focused: p.focused === 'a' ? 'b' : 'a' }
          : p,
      ),
    );
  }, []);

  const setSlotTab = useCallback((key: string, slot: SlotId, ref: SlotRef) => {
    updatePairings((prev) =>
      prev.map((p) => {
        if (p.a.tabId !== key) return p;
        if (p.a.tabId === ref.tabId || p.b.tabId === ref.tabId) return p; // already a member
        return { ...p, [slot]: ref, focused: slot };
      }),
    );
  }, []);

  const setPairings = useCallback((next: SplitState[]) => updatePairings(next), []);

  const clear = useCallback(() => updatePairings([]), []);

  return {
    pairings,
    openSplit,
    dissolve,
    setRatio,
    toggleOrientation,
    focusSlot,
    swapSlots,
    setSlotTab,
    setPairings,
    clear,
  };
}
