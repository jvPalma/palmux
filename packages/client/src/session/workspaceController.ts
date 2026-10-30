// ── Workspace navigation controller (pure) ────────────────────────────────────
//
// The decision core of the App hub: given a navigation EVENT and a read-only
// context (the current session id, which pane holds a tab, tabs, seen
// terminals, mode), it returns a list of declarative EFFECTS. App translates
// gestures/sockets into events and applies the effects (`setSessionId` through
// the layout's `show`, the pane grid's `splitPane`). Pure ⇒ every navigation
// invariant (recycled-id, close-nav, lone-tab split) is a direct unit test
// instead of a full-render DOM assertion.
//
// With editor groups ENABLED (the desktop) the layout owns the selection and the
// per-pane close-navigation: `pane-grid.ts`'s `reconcile` re-picks a pane's active
// tab by the same left-then-right rule on every broadcast. What stays here is the
// one decision no pane can make, "the last tab went", and, for the mobile layer (one
// virtual pane, no layout to reconcile), the neighbour rule itself. A detached window
// has groups on and decides neither: reconcile owns its close-navigation, and an empty
// window closes itself.

import type { TabMeta } from '@palmux/shared';
import { neighborAfterClose } from './tab-meta';

export interface WorkspaceCtx {
  sessionId: string;
  /** The CURRENT tab list (for a `sessionsBroadcast` this is the pre-broadcast list). */
  tabs: TabMeta[];
  mobileActive: boolean;
  /** Terminal ids ever seen in a broadcast (fresh-vs-killed discrimination). */
  seenTermIds: ReadonlySet<string>;
  /**
   * A detached window: its panes reconcile the close-navigation and its empty list is a window that
   * closes itself, so a `sessionsBroadcast` never asks for the New-tab page there.
   */
  detached: boolean;
  /** Editor groups are on: the desktop and a detached window, not the mobile layer. */
  groups: boolean;
  /** The pane holding a tab and how many tabs that pane holds, or null when none does. */
  leafOf: (tabId: string) => { id: string; count: number } | null;
  /**
   * A pane holds a tab no broadcast has listed yet: a terminal this window picked an id for, which
   * exists on the server only once its pane attaches.
   */
  holdsPending: boolean;
}

export type WorkspaceEvent =
  | { type: 'selectTab'; id: string }
  /** Split right / Split down on a tab: it moves into a new pane to its pane's right or below. */
  | { type: 'menuSplit'; tabId: string; side: 'right' | 'bottom' }
  | { type: 'tabCreated'; id: string }
  /** A `sessions` broadcast — only the close-navigation decision (App applies the
   *  rest). `tabs` is the NEW list; `ctx.tabs` is the OLD one. */
  | { type: 'sessionsBroadcast'; tabs: TabMeta[] };

export type WorkspaceEffect =
  /**
   * Show this tab.
   *
   * It used to carry a `mode` — push / replace / set — which described what to
   * do with the browser's URL. Nothing writes the URL any more: the app lives at
   * `/` and each window remembers its own selection, so there is one way to
   * navigate and the mode had nothing left to say.
   */
  | { type: 'navigate'; id: string }
  | { type: 'chooserPage'; value: boolean }
  /** Move `tabId` out of pane `leafId` into a new pane on `side` of it. */
  | { type: 'split'; leafId: string; tabId: string; side: 'right' | 'bottom' }
  /**
   * The tab is its pane's only one, so there is nothing to move: App opens a new
   * terminal in the new pane (it picks the id, as `createTab` does).
   */
  | { type: 'splitLone'; leafId: string; side: 'right' | 'bottom' };

export function decide(event: WorkspaceEvent, ctx: WorkspaceCtx): WorkspaceEffect[] {
  switch (event.type) {
    case 'selectTab':
      // Every selection is an ordinary navigation; the layout turns it into "activate it
      // where it is, else in the focused pane". chooserPage clears.
      return [
        { type: 'chooserPage', value: false },
        { type: 'navigate', id: event.id },
      ];

    case 'menuSplit': {
      // No split on the mobile layer: there is one virtual pane.
      if (!ctx.groups || ctx.mobileActive) return [];
      const leaf = ctx.leafOf(event.tabId);
      if (!leaf) return [];
      return leaf.count === 1
        ? [{ type: 'splitLone', leafId: leaf.id, side: event.side }]
        : [{ type: 'split', leafId: leaf.id, tabId: event.tabId, side: event.side }];
    }

    case 'tabCreated':
      // The server answered a create with the assigned id: show it (a tab that already
      // exists, as a review's idempotent create answers, is activated where it is).
      return [
        { type: 'chooserPage', value: false },
        { type: 'navigate', id: event.id },
      ];

    case 'sessionsBroadcast': {
      // A detached window takes no New-tab effect from here: its last tab leaving is the window's
      // end, which App's self-close owns (it shows the New-tab page only if the browser refuses to
      // close the window). This does not stop the page from rendering in between: App's layout
      // effect sets it when the focused pane is left with no active tab. Everything else is
      // reconcile's.
      if (ctx.detached) return [];
      // With groups, each pane re-picks its own active tab during reconcile, so the only
      // decision left is the empty list: nothing to show, the New-tab PAGE is the content. Not
      // while a pane holds a terminal this window just created: the list lacks it only because its
      // attach has not spawned it yet, and the page would unmount the pane that is about to.
      if (ctx.groups) {
        return event.tabs.length === 0 && !ctx.holdsPending
          ? [{ type: 'chooserPage', value: true }]
          : [];
      }
      // The ACTIVE tab was closed → go to its LEFT strip neighbor, else right;
      // nothing left → the New-tab PAGE. A never-broadcast terminal is FRESH
      // (its attach hasn't spawned it), not closed.
      const active = ctx.sessionId;
      const gone = !event.tabs.some((t) => t.id === active);
      const wasLive =
        ctx.seenTermIds.has(active) ||
        ctx.tabs.some((t) => t.id === active && t.kind !== 'terminal');
      if (!gone || !wasLive) return [];
      const survivors = new Set(event.tabs.map((t) => t.id));
      const target = neighborAfterClose(
        ctx.tabs.map((t) => t.id),
        active,
        survivors,
      );
      return target !== null
        ? [{ type: 'navigate', id: target }]
        : [{ type: 'chooserPage', value: true }];
    }
  }
}
