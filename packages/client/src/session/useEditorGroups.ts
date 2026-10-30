// ── Editor groups: the window's pane layout, as a hook ────────────────────────
//
// `pane-grid.ts` holds the rules; this holds the one layout a window has, keeps it
// honest against the server's tab list, and saves it. The layout answers "which pane
// holds which tab". `window-selection.ts` still answers "what is this window showing"
// at boot, and from then on the focused pane's active tab IS the selection (App derives
// its `sessionId` from `focusedActive`).
//
// Saved per WINDOW only (`sessionStorage`). There is deliberately no device-wide copy:
// a window that inherited N panes would attach N terminals at once and evict them from
// any other window that has them (last attach wins). A fresh window or a relaunched PWA
// opens one pane on the selection `window-selection.ts` picks.
//
// Nothing exists before the first broadcast has been reconciled (`layout` is null until
// `ready`), so a saved pane for a terminal that has closed is dropped instead of attaching
// a pane that would spawn a shell for it.
//
// Reconcile runs DURING RENDER, as state derived from the new `tabs`, and not in an effect:
// an effect would commit one frame with the old layout, and a pane for a dead terminal
// attaches in that frame. `tabs` must therefore keep its identity between broadcasts (App
// holds it in state). What reconcile reads that outlives a render (`prevOrder`, `pending`, and
// the list the committed layout agrees with) lives in refs, written only after commit, never
// during render.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TabKind, TabMeta } from '@palmux/shared';
import {
  activate,
  addTab,
  firstInOrder,
  focusLeaf,
  layoutRects,
  leafOf,
  leaves,
  moveTab,
  parseLayout,
  reconcile,
  singleLeaf,
  splitPane,
  type PaneLayout,
  type Rect,
  type Sash,
  type Side,
  type TabRef,
} from './pane-grid';

/** The window's saved layout (`sessionStorage`; the mobile layer never touches it). */
export const LAYOUT_STORE_KEY = 'palmux-layout';

/**
 * The saved-layout key of a window: the main window's (`wid` null), or a detached window's own.
 * `window.open` may copy the opener's `sessionStorage`, so a detached window that read the main
 * key would boot from the main window's panes.
 */
export function layoutKey(wid: string | null): string {
  return wid ? `${LAYOUT_STORE_KEY}:${wid}` : LAYOUT_STORE_KEY;
}

/** A request to show a tab (`show`). */
export interface ShowRef {
  id: string;
  kind: TabKind;
  /** The id is in the tab list the caller can see. False = a terminal this window just picked an id for. */
  known: boolean;
}

/**
 * Where a tab that has not reached this window yet should land when it does: a tab dragged in from
 * another window is listed only after the server moves it, so the drop parks its target here.
 */
export interface Placement {
  id: string;
  /** The pane the drop was on. A pane that is gone by the time the tab arrives means the focused one. */
  leafId: string;
  /** `centre` moves the tab into the pane and shows it; a side opens a new pane on that side. */
  where: 'centre' | Side;
}

export interface UseEditorGroupsOptions {
  /** False on the mobile layer: one virtual pane, nothing saved. */
  enabled: boolean;
  /** The server's tabs in strip order. Keep this array's identity between broadcasts. */
  tabs: TabMeta[];
  /** The first `sessions` broadcast has landed. */
  ready: boolean;
  /** The stored selection, when it resolved to a live tab of its kind (else null). Boot only. */
  bootSelection: string | null;
  /** What this window shows. Read only while `enabled` is false, to draw the one pane. */
  sessionId: string;
  /**
   * Where the layout is saved and read (default `LAYOUT_STORE_KEY`; `layoutKey(wid)` in a detached
   * window). `tabs` is then only the part of the server's list this window shows, and so is `order`
   * everywhere below: a pane holds visible ids only, and the visible order is a subsequence of the
   * full one.
   */
  storageKey?: string;
}

export interface UseEditorGroupsResult {
  /** Null until `ready`. */
  layout: PaneLayout | null;
  rects: ReadonlyMap<string, Rect>;
  sashes: Sash[];
  /** The focused pane's active tab: the window's selected tab. */
  focusedActive: string | null;
  /** Whether a layout is saved for this window. Reads storage; call it while groups are enabled. */
  hasSavedLayout(): boolean;
  /** Show a tab: where it already is, else in the focused pane. */
  show(ref: ShowRef): void;
  /**
   * Park where a tab that is not in this window yet should land (see `Placement`). Applied in the
   * render where the tab first appears in the layout, which also focuses the target, then
   * forgotten. Dropped while groups are off or before the first broadcast.
   */
  place(p: Placement): void;
  /** Every tab id in the held layout, else in the saved one (a window that has not booted yet). */
  heldTabIds(): string[];
  /** Take a new layout and save it. */
  commit(next: PaneLayout): void;
  /** Draw a layout without saving it (a sash drag); `commit` the final one. */
  setLive(next: PaneLayout): void;
  /**
   * Ids this window put into the layout that no broadcast has listed yet. Mutable on purpose: a
   * caller that adds a pane for a terminal it just picked an id for adds the id here too.
   */
  pending: Set<string>;
  /** A pane's tabs for its strip, in server order. Stable while the pane and `tabs` are. */
  stripTabs(leafId: string): TabMeta[];
}

interface Held {
  layout: PaneLayout;
  /** Drawn but not saved: a sash is being dragged. */
  live: boolean;
  /** Kept in step with the tab list. False once groups are disabled; the layout is then only a memory. */
  active: boolean;
  /**
   * A tab list `layout` agrees with. Set whenever the layout is rebuilt; a broadcast that changes
   * nothing leaves it (no new state, so it costs no second render) and `agreedRef` records it.
   */
  tabs: TabMeta[];
}

interface State {
  held: Held | null;
  /** A `show` that arrived before the first broadcast: `?new=1`, a legacy `/<id>`. */
  boot: ShowRef | null;
  /** A render with `ready` has happened, so the next time groups turn on is a restore, not a boot. */
  booted: boolean;
  /**
   * Ids the last restore put in the layout that the list does not hold (a terminal the phone just
   * picked an id for). Added to `pending` after commit; a new array per restore.
   */
  unlisted: readonly string[];
  /** Placements still waiting for their tab to reach the layout. */
  placements: readonly Placement[];
}

const NO_IDS: readonly string[] = [];
const NO_PLACEMENTS: readonly Placement[] = [];
const INITIAL: State = {
  held: null,
  boot: null,
  booted: false,
  unlisted: NO_IDS,
  placements: NO_PLACEMENTS,
};
const NO_PENDING: ReadonlySet<string> = new Set();
const NO_TABS: TabMeta[] = [];
const NO_RECTS = { panes: new Map<string, Rect>(), sashes: [] as Sash[] };

const refOf = (t: TabMeta): TabRef => ({ id: t.id, kind: t.kind });

function readSaved(key: string): PaneLayout | null {
  try {
    return parseLayout(sessionStorage.getItem(key));
  } catch {
    return null; // storage unavailable — the window simply starts with one pane
  }
}

/** Show a tab where it is, else in the focused pane. The same layout when that changes nothing. */
function showIn(layout: PaneLayout, ref: { id: string; kind: TabKind }): PaneLayout {
  const holder = leafOf(layout, ref.id);
  if (holder) return focusLeaf(activate(layout, holder.id, ref.id), holder.id);
  return addTab(layout, layout.focused, { id: ref.id, kind: ref.kind }, true);
}

const kindIn = (tabs: TabMeta[], id: string): TabKind | undefined =>
  tabs.find((t) => t.id === id)?.kind;

/**
 * The layout of the first ready render: the saved one, else one pane holding every tab, either way
 * reconciled against the first list with nothing pending (a saved terminal that is gone is dropped
 * and never attached), then the boot selection and a `show` that came before the list.
 */
function bootLayout(
  tabs: TabMeta[],
  bootSelection: string | null,
  show: ShowRef | null,
  key: string,
): PaneLayout {
  const base = readSaved(key) ?? singleLeaf(tabs.map(refOf), bootSelection);
  let layout = reconcile(base, tabs, [], NO_PENDING);
  if (!bootSelection && !show) {
    // Nothing names a tab to open on, and the one pane shows none: every saved tab died, or the
    // window was saved on the New-tab page, or there is no saved layout. A boot is not the New-tab
    // page, so it opens on the first tab in server order.
    const order = tabs.map((t) => t.id);
    const focused = leaves(layout).find((l) => l.id === layout.focused);
    const first = focused?.active === null ? firstInOrder(focused.tabs, order) : null;
    if (first) layout = activate(layout, layout.focused, first);
  }
  // `bootSelection` names a live tab, so reconcile already put it in a pane: it only has to win.
  if (bootSelection) {
    layout = showIn(layout, { id: bootSelection, kind: kindIn(tabs, bootSelection) ?? 'terminal' });
  }
  // `known` is judged against THIS list: a tab it holds is activated where it is. One it does not
  // is a terminal whose attach will spawn it (and `show` already put it in `pending`).
  if (show) layout = showIn(layout, { id: show.id, kind: kindIn(tabs, show.id) ?? show.kind });
  return layout;
}

/**
 * The layout when groups turn ON after having been off (the mobile layer left): the saved one, else
 * one pane (keeping the id the virtual pane had, so its terminal is not remounted), with the window's
 * selection shown. If the saved focused pane does not hold it, it moves panes like any other move.
 * `unlisted` is that selection when the list does not hold it: a terminal the phone just picked an
 * id for, which must be pending or the next broadcast that lacks it drops the pane creating it.
 */
function restoreLayout(
  tabs: TabMeta[],
  sessionId: string,
  heldFocusedId: string | undefined,
  key: string,
): { layout: PaneLayout; unlisted: readonly string[] } {
  const base = readSaved(key) ?? singleLeaf(tabs.map(refOf), sessionId, heldFocusedId ?? 'p0');
  const layout = reconcile(base, tabs, [], NO_PENDING);
  if (!sessionId) return { layout, unlisted: NO_IDS };
  const kind = kindIn(tabs, sessionId);
  return {
    layout: showIn(layout, { id: sessionId, kind: kind ?? 'terminal' }),
    unlisted: kind === undefined ? [sessionId] : NO_IDS,
  };
}

interface DeriveInput extends UseEditorGroupsOptions {
  prevOrder: string[];
  pending: ReadonlySet<string>;
  /** The list the last committed layout agrees with (`agreedRef`). */
  agreed: TabMeta[] | null;
}

/**
 * Apply every parked placement whose tab is in the layout now; the rest keep waiting. The tab
 * leaves the pane reconcile put it in (the focused one) for the pane the drop was on. Both
 * operations focus the target. `order` is the visible list's ids, as everywhere else here.
 */
function applyPlacements(
  layout: PaneLayout,
  parked: readonly Placement[],
  order: string[],
): { layout: PaneLayout; waiting: readonly Placement[] } {
  const waiting: Placement[] = [];
  let next = layout;
  for (const p of parked) {
    const holder = leafOf(next, p.id);
    if (!holder) {
      waiting.push(p);
      continue;
    }
    const ref = holder.tabs.find((t) => t.id === p.id)!;
    const target = leaves(next).some((l) => l.id === p.leafId) ? p.leafId : next.focused;
    next =
      p.where === 'centre'
        ? activate(moveTab(next, p.id, target, order), target, p.id)
        : splitPane(next, target, p.where, ref, order);
  }
  return { layout: next, waiting };
}

/** What the state must be for this render. The SAME state when nothing needs to change. */
function derive(state: State, input: DeriveInput): State {
  if (!input.ready) return state;
  const { held, booted } = state;
  if (!input.enabled) {
    if (!held?.active && booted) return state;
    return { ...state, booted: true, held: held && { ...held, active: false } };
  }
  const key = input.storageKey ?? LAYOUT_STORE_KEY;
  if (held?.active) {
    const parked = state.placements;
    const sameList = held.tabs === input.tabs || input.agreed === input.tabs;
    if (sameList && parked.length === 0) return state;
    const reconciled = sameList
      ? held.layout
      : reconcile(held.layout, input.tabs, input.prevOrder, input.pending);
    // After reconcile, which is what puts a tab another window just handed over into a pane. An
    // applied placement leaves `placements` in the SAME state change, so the render this state
    // triggers cannot apply it twice (a side drop would split twice).
    const { layout, waiting } = applyPlacements(
      reconciled,
      parked,
      input.tabs.map((t) => t.id),
    );
    // Nothing changed: the same state, so this render is the only one the broadcast costs.
    if (layout === held.layout && waiting.length === parked.length) return state;
    return {
      ...state,
      held: { ...held, layout, live: false, tabs: input.tabs },
      placements: waiting,
    };
  }
  if (booted) {
    const restored = restoreLayout(input.tabs, input.sessionId, held?.layout.focused, key);
    return {
      held: { layout: restored.layout, live: false, active: true, tabs: input.tabs },
      boot: null,
      booted: true,
      unlisted: restored.unlisted,
      placements: NO_PLACEMENTS,
    };
  }
  return {
    held: {
      layout: bootLayout(input.tabs, input.bootSelection, state.boot, key),
      live: false,
      active: true,
      tabs: input.tabs,
    },
    boot: null,
    booted: true,
    unlisted: NO_IDS,
    placements: NO_PLACEMENTS,
  };
}

export function useEditorGroups(options: UseEditorGroupsOptions): UseEditorGroupsResult {
  const { enabled, tabs, ready, sessionId, storageKey = LAYOUT_STORE_KEY } = options;
  const [state, setState] = useState<State>(INITIAL);

  const pendingRef = useRef<Set<string>>(new Set());
  const pending = pendingRef.current;
  const prevOrderRef = useRef<string[]>([]);
  const agreedRef = useRef<TabMeta[] | null>(null);
  // The latest `enabled`, for callbacks whose identity must not change with it.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const next = derive(state, {
    ...options,
    prevOrder: prevOrderRef.current,
    pending,
    agreed: agreedRef.current,
  });
  if (next !== state) setState(next);
  const held = next.held;

  // The layout being held, for callers outside a render (`heldTabIds`). Written after commit.
  const heldLayoutRef = useRef<PaneLayout | null>(null);
  const heldLayout = held?.layout ?? null;
  useEffect(() => {
    heldLayoutRef.current = heldLayout;
  }, [heldLayout]);

  // After commit: the list the committed layout agrees with (derive reconciled it against this
  // list, or found it already did), so a later render with the same list skips reconcile, and a
  // `commit` or `setLive` of a layout computed from an older capture is reconciled against it.
  const agreed = held?.active ? tabs : null;
  useEffect(() => {
    agreedRef.current = agreed;
  }, [agreed]);

  const { unlisted } = next;
  useEffect(() => {
    for (const id of unlisted) pending.add(id);
  }, [unlisted, pending]);

  // After commit, never during render: the order this broadcast carried (the next one's "before"),
  // and the ids it listed, which are pending no more. `ready` is a dependency because a `show` from
  // before the list can name a tab the first list holds, and that list may not be a new array.
  useEffect(() => {
    prevOrderRef.current = tabs.map((t) => t.id);
    for (const t of tabs) pending.delete(t.id);
  }, [tabs, ready, pending]);

  const stripCache = useRef(new Map<string, { src: TabRef[]; tabs: TabMeta[]; list: TabMeta[] }>());

  const layout = useMemo<PaneLayout | null>(() => {
    if (!ready) return null;
    if (enabled) return held?.active ? held.layout : null;
    // One virtual pane: a phone creates a terminal by selecting an id the server has not listed, so
    // `singleLeaf` appends an unknown `sessionId` as a terminal, as the attach fallback expects.
    return singleLeaf(tabs.map(refOf), sessionId, held?.layout.focused ?? 'p0');
  }, [ready, enabled, held, tabs, sessionId]);

  const geometry = useMemo(() => (layout ? layoutRects(layout) : NO_RECTS), [layout]);

  const focusedActive = useMemo(
    () => (layout ? (leaves(layout).find((l) => l.id === layout.focused)?.active ?? null) : null),
    [layout],
  );

  // Saved on every committed change; a sash drag is `live` and saved once, by its `commit`.
  const saved = held?.active && !held.live ? held.layout : null;
  useEffect(() => {
    if (!saved) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      /* storage full / unavailable — a layout is a discardable view preference */
    }
  }, [saved, storageKey]);

  useEffect(() => {
    const cache = stripCache.current;
    const live = new Set(layout ? leaves(layout).map((l) => l.id) : []);
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  }, [layout]);

  const stripTabs = useCallback(
    (leafId: string): TabMeta[] => {
      const leaf = layout ? leaves(layout).find((l) => l.id === leafId) : undefined;
      if (!leaf) return NO_TABS;
      const cached = stripCache.current.get(leafId);
      // Keyed on the pane's tab array and the list, not on the pane: activating a tab replaces the
      // pane object but not its tabs, and the strip must not redraw for it.
      if (cached && cached.src === leaf.tabs && cached.tabs === tabs) return cached.list;
      const ids = new Set(leaf.tabs.map((t) => t.id));
      const list = tabs.filter((t) => ids.has(t.id));
      stripCache.current.set(leafId, { src: leaf.tabs, tabs, list });
      return list;
    },
    [layout, tabs],
  );

  const show = useCallback(
    (ref: ShowRef) => {
      if (!enabledRef.current || !ref.id) return;
      // Before the updater, not in it (an updater must be pure) and before any render can reconcile:
      // a terminal this window picked an id for exists on the server only once its pane attaches.
      if (!ref.known) pending.add(ref.id);
      setState((s) => {
        if (!s.booted) return { ...s, boot: ref };
        if (!s.held?.active) return s;
        const shown = showIn(s.held.layout, ref);
        return shown === s.held.layout
          ? s
          : { ...s, held: { ...s.held, layout: shown, live: false } };
      });
    },
    [pending],
  );

  // A layout a caller hands in may be computed from an older capture (a sash drag resizes the
  // layout it took at pointerdown, and a broadcast can land mid-drag): it is reconciled against
  // the list the held layout agrees with, so it can never bring back a tab that list dropped.
  // `pending` is read at call time, after a caller that adds an id has added it.
  const adopt = useCallback(
    (layoutNext: PaneLayout, live: boolean) => {
      const agreedNow = agreedRef.current;
      const pendingNow = new Set(pending);
      setState((s) => {
        if (!s.held?.active) return s;
        const list = agreedNow ?? s.held.tabs;
        const reconciled = reconcile(layoutNext, list, [], pendingNow);
        if (reconciled === s.held.layout && (live || !s.held.live)) return s;
        return { ...s, held: { ...s.held, layout: reconciled, live, tabs: list } };
      });
    },
    [pending],
  );

  const commit = useCallback((layoutNext: PaneLayout) => adopt(layoutNext, false), [adopt]);
  const setLive = useCallback((layoutNext: PaneLayout) => adopt(layoutNext, true), [adopt]);

  const place = useCallback((p: Placement) => {
    // Nothing to place into before the layout is held, or while it is only a memory.
    setState((s) => (s.held?.active ? { ...s, placements: [...s.placements, p] } : s));
  }, []);

  const hasSavedLayout = useCallback(() => readSaved(storageKey) !== null, [storageKey]);

  const heldTabIds = useCallback((): string[] => {
    const layoutNow = heldLayoutRef.current ?? readSaved(storageKey);
    return layoutNow ? leaves(layoutNow).flatMap((l) => l.tabs.map((t) => t.id)) : [];
  }, [storageKey]);

  return {
    layout,
    rects: geometry.panes,
    sashes: geometry.sashes,
    focusedActive,
    hasSavedLayout,
    show,
    place,
    heldTabIds,
    commit,
    setLive,
    pending,
    stripTabs,
  };
}
