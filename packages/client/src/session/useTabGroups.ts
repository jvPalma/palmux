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
  sessionId: string;
  /** Read at call time inside handlers. */
  tabsRef: MutableRefObject<TabMeta[]>;
  sessionIdRef: MutableRefObject<string>;
  dirtyRef: MutableRefObject<{ [id: string]: boolean }>;
  wsRef: MutableRefObject<WsClient | null>;
  switchSession: (id: string) => void;
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
  sessionId,
  tabsRef,
  sessionIdRef,
  dirtyRef,
  wsRef,
  switchSession,
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

  // Persist the collapsed-group view state per device.
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  // THE centralized auto-expand: whenever the active tab belongs to
  // a COLLAPSED group, expand it. Keyed on sessionId + tabs — the only two inputs
  // the body reads (membership lives on tabs, via groupId). This fires for EVERY
  // path that lands on a tab, including the many that call setSessionId directly
  // (split re-tile, boot, close-nav, popstate, reconcile) and bypass selectTab.
  // Reads collapsed via ref so it never loops on its own update (the updater also
  // bails with the same Set reference).
  useEffect(() => {
    const gid = groupIdOf(tabs, sessionId);
    if (gid && collapsedRef.current.has(gid)) {
      setCollapsed((prev) => {
        if (!prev.has(gid)) return prev;
        const next = new Set(prev);
        next.delete(gid);
        return next;
      });
    }
  }, [sessionId, tabs]);

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
      const src = tabsRef.current;
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
    [tabsRef, wsRef],
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

  // Collapse toggle with the active-tab guard: collapsing a group that owns the
  // active tab would hide the visible pane — navigate to the nearest OUTSIDE tab
  // first, and refuse (toast) when the group IS the whole strip.
  const toggleGroup = useCallback(
    (gid: string) => {
      // Single-flight per user gesture (one chip click / one drawer-header tap),
      // so the ref snapshot here and the functional updater below always agree on
      // whether we're collapsing — no path invokes this twice within one batch.
      const collapsing = !collapsedRef.current.has(gid);
      if (collapsing && groupIdOf(tabsRef.current, sessionIdRef.current) === gid) {
        const ids = tabsRef.current.map((t) => t.id);
        const outside = nearestOutside(ids, groupIdMap(tabsRef.current), gid);
        if (outside === null) {
          showToast("Can't collapse the only group");
          return;
        }
        switchSession(outside);
      }
      setCollapsed((prev) => {
        const nextSet = new Set(prev);
        if (nextSet.has(gid)) nextSet.delete(gid);
        else nextSet.add(gid);
        return nextSet;
      });
    },
    [switchSession, showToast, sessionIdRef, tabsRef],
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
