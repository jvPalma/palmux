// ── Tab-group state + operations (extracted from App) ─────────────────────────
//
// Owns the group METADATA model (as broadcast) and the per-device COLLAPSE view
// state, plus the group operations that mutate them. Extracting this out of the
// App hub makes the whole tab-group concern unit-testable in isolation and keeps
// its three cohesive effects (persist / auto-expand / prune) colocated. App keeps
// only the two OPTIMISTIC strip-reorder handlers (doReorder, moveGroup) that need
// its `setTabs` — they read this hook's `collapsedRef`.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { TabGroup, TabMeta } from '@palmux/shared';
import type { WsClient } from '../lib/ws';
import { groupIdMap, groupIdOf, nearestOutside, parseCollapsed } from './tab-groups';
import { pruneSet } from './tab-meta';
import { closeManyMessage } from './close-many';

/** Per-device collapsed-group ids (view-only state; the model is server-owned). */
const COLLAPSED_KEY = 'palmux-collapsed-groups';

interface UseTabGroupsOptions {
  /** Reactive — the auto-expand effect keys on these (every path that lands on a tab). */
  tabs: TabMeta[];
  /**
   * Every pane's active tab: the tabs on screen. With editor groups that is one per pane; without
   * them (the mobile layer) it is `[sessionId]`. Keep the array's identity while the set
   * is unchanged: the auto-expand effect keys on it.
   */
  activeIds: string[];
  /**
   * The ids of every tab in the pane that holds `tabId`, in server order (without editor groups,
   * the whole list). Read at call time: the collapse guard looks for a way out inside that pane.
   */
  stripOf: (tabId: string) => string[];
  /** Show `toId` in the pane that shows `fromId`. */
  switchTo: (fromId: string, toId: string) => void;
  /** Read at call time inside handlers. */
  tabsRef: MutableRefObject<TabMeta[]>;
  /**
   * The FULL tab list, hidden tabs included, when `tabs` is only the part this window shows
   * (a detached window, or a main window with one open). Read only by `addToGroup`, whose
   * `order` must keep every other window's tabs in place: the server appends an id a request
   * omits at the END. Defaults to `tabsRef`. Collapse, switch, close-all and remove stay on the
   * visible list, so they never reach a tab another window shows.
   */
  fullTabsRef?: MutableRefObject<TabMeta[]>;
  dirtyRef: MutableRefObject<{ [id: string]: boolean }>;
  wsRef: MutableRefObject<WsClient | null>;
  showToast: (msg: string) => void;
}

export interface TabGroupsApi {
  groups: TabGroup[];
  collapsed: Set<string>;
  /** For App's optimistic reorder handlers to read the latest collapsed set. */
  collapsedRef: MutableRefObject<Set<string>>;
  /** Apply a `sessions` broadcast's group list: set groups + prune dangling collapsed ids. */
  applyBroadcast: (nextGroups: TabGroup[]) => void;
  toggleGroup: (gid: string) => void;
  newGroup: (id: string) => void;
  addToGroup: (id: string, gid: string) => void;
  removeFromGroup: (id: string) => void;
  groupRename: (gid: string, name: string) => void;
  groupRecolor: (gid: string, color: string) => void;
  groupDissolve: (gid: string) => void;
  groupCloseAll: (gid: string) => void;
}

export function useTabGroups({
  tabs,
  activeIds,
  stripOf,
  switchTo,
  tabsRef,
  fullTabsRef = tabsRef,
  dirtyRef,
  wsRef,
  showToast,
}: UseTabGroupsOptions): TabGroupsApi {
  const [groups, setGroups] = useState<TabGroup[]>([]);
  // Collapsed groups are a per-device view concern (not on the wire): boot from
  // localStorage, prune to live group ids on each broadcast, persist on change.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(parseCollapsed(localStorage.getItem(COLLAPSED_KEY))),
  );
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  // The newest on-screen tabs and pane lookup, for the collapse guard, which runs from a click.
  const activeIdsRef = useRef(activeIds);
  activeIdsRef.current = activeIds;
  const stripOfRef = useRef(stripOf);
  stripOfRef.current = stripOf;

  // Persist the collapsed-group view state per device.
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  // THE centralized auto-expand: whenever a tab on screen (any pane's active tab) belongs to
  // a COLLAPSED group, expand it. Keyed on activeIds + tabs — the only two inputs
  // the body reads (membership lives on tabs, via groupId). This fires for EVERY
  // path that lands on a tab, including the many that change the selection directly
  // (a drop into a pane, boot, close-nav, reconcile) and bypass selectTab.
  // Reads collapsed via ref so it never loops on its own update (the updater also
  // bails with the same Set reference).
  useEffect(() => {
    const open = new Set<string>();
    for (const id of activeIds) {
      const gid = groupIdOf(tabs, id);
      if (gid && collapsedRef.current.has(gid)) open.add(gid);
    }
    if (open.size === 0) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const gid of open) next.delete(gid);
      return next.size === prev.size ? prev : next;
    });
  }, [activeIds, tabs]);

  const applyBroadcast = useCallback((nextGroups: TabGroup[]) => {
    setGroups(nextGroups);
    // Prune collapsed view-state to groups that still exist (a dissolved or
    // emptied group must not leave a dangling collapsed id).
    setCollapsed((prev) => pruneSet(prev, new Set(nextGroups.map((g) => g.id))));
  }, []);

  const newGroup = useCallback(
    (id: string) => {
      wsRef.current?.sendGroupCreate([id]);
    },
    [wsRef],
  );
  const addToGroup = useCallback(
    (id: string, gid: string) => {
      const src = fullTabsRef.current;
      const members = src.filter((t) => t.groupId === gid).map((t) => t.id);
      // Pull the tab TO the group (Chrome-style) — land it right after the last
      // member so the group's block stays put, instead of letting normalizeOrder
      // make a left-of-group tab the new first member and shift the whole block.
      if (members.length === 0) {
        wsRef.current?.sendGroupUpdate({ id: gid, addIds: [id] });
        return;
      }
      const without = src.map((t) => t.id).filter((x) => x !== id);
      const at = without.indexOf(members[members.length - 1]!) + 1;
      const order = [...without.slice(0, at), id, ...without.slice(at)];
      wsRef.current?.sendGroupUpdate({ id: gid, addIds: [id], order });
    },
    [fullTabsRef, wsRef],
  );
  const removeFromGroup = useCallback(
    (id: string) => {
      const gid = groupIdOf(tabsRef.current, id);
      if (gid) wsRef.current?.sendGroupUpdate({ id: gid, removeIds: [id] });
    },
    [tabsRef, wsRef],
  );
  const groupRename = useCallback(
    (gid: string, name: string) => {
      wsRef.current?.sendGroupUpdate({ id: gid, name });
    },
    [wsRef],
  );
  const groupRecolor = useCallback(
    (gid: string, color: string) => {
      wsRef.current?.sendGroupUpdate({ id: gid, color });
    },
    [wsRef],
  );
  const groupDissolve = useCallback(
    (gid: string) => {
      wsRef.current?.sendGroupUpdate({ id: gid, dissolve: true });
    },
    [wsRef],
  );

  // Collapse toggle with the active-tab guard: collapsing a group that owns a pane's
  // active tab would hide the visible pane — that pane first navigates to the nearest
  // OUTSIDE tab of ITS OWN strip, and the whole collapse is refused (toast) when any
  // pane has none, i.e. the group IS that pane's whole strip. Every pane is checked
  // before any is switched, so a refusal leaves every pane where it was.
  const toggleGroup = useCallback(
    (gid: string) => {
      // Single-flight per user gesture (one chip click / one drawer-header tap),
      // so the ref snapshot here and the functional updater below always agree on
      // whether we're collapsing — no path invokes this twice within one batch.
      const collapsing = !collapsedRef.current.has(gid);
      if (collapsing) {
        const groupOf = groupIdMap(tabsRef.current);
        const moves: Array<[from: string, to: string]> = [];
        for (const active of activeIdsRef.current) {
          if (groupOf(active) !== gid) continue;
          const outside = nearestOutside(stripOfRef.current(active), groupOf, gid);
          if (outside === null) {
            showToast("Can't collapse the only group");
            return;
          }
          moves.push([active, outside]);
        }
        for (const [from, to] of moves) switchTo(from, to);
      }
      setCollapsed((prev) => {
        const nextSet = new Set(prev);
        if (nextSet.has(gid)) nextSet.delete(gid);
        else nextSet.add(gid);
        return nextSet;
      });
    },
    [switchTo, showToast, tabsRef],
  );

  // Close every tab in a group behind ONE kind-aware confirmation: it names the
  // terminal kill count and calls out any dirty editor members, so a bulk close
  // never silently discards unsaved work.
  const groupCloseAll = useCallback(
    (gid: string) => {
      const members = tabsRef.current.filter((t) => t.groupId === gid);
      const message = closeManyMessage(
        members,
        dirtyRef.current,
        `Close all ${members.length} tabs in this group?`,
      );
      if (!message || !window.confirm(message)) return;
      for (const t of members) wsRef.current?.sendKill(t.id);
    },
    [tabsRef, dirtyRef, wsRef],
  );

  return {
    groups,
    collapsed,
    collapsedRef,
    applyBroadcast,
    toggleGroup,
    newGroup,
    addToGroup,
    removeFromGroup,
    groupRename,
    groupRecolor,
    groupDissolve,
    groupCloseAll,
  };
}
