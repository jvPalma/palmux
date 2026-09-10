// ── Workspace navigation controller (pure) ────────────────────────────────────
//
// The decision core of the App hub: given a navigation EVENT and a read-only
// context (the current session id, the set of split PAIRINGS, tabs, seen
// terminals, mode), it returns a list of declarative EFFECTS. App translates
// gestures/sockets into events and applies the effects (history + setSessionId +
// the useSplit ops + the fuse-sync wire message). Pure ⇒ every navigation
// invariant (member focus, split-outside-new-tabs, eject-to-survivor,
// recycled-id, close-nav, fuse ordering) is a direct unit test instead of a
// full-render DOM assertion.
//
// A PAIRING is one SplitState; its stable KEY is `a.tabId`. `pairingOf` finds
// the pairing a tab belongs to; the ACTIVE pairing is the one containing the
// current session id (on screen). splitShown is subsumed: sessionId is a member
// iff its pairing is displayed.

import type { TabKind, TabMeta } from '@palmux/shared';
import { nextFreeId } from './session-url';
import { neighborAfterClose } from './tab-meta';
import {
  memberSlot,
  pairingOf,
  type Orientation,
  type SlotId,
  type SlotRef,
  type SplitState,
} from './useSplit';

export interface WorkspaceCtx {
  sessionId: string;
  /** Every live split pairing (each a stable two-tab SplitState). */
  pairings: SplitState[];
  /** The CURRENT tab list (for fuse ctx this is the pre-broadcast list). */
  tabs: TabMeta[];
  mobileActive: boolean;
  activeKind: TabKind;
  /** Terminal ids ever seen in a broadcast (fresh-vs-killed discrimination). */
  seenTermIds: ReadonlySet<string>;
  /** A popped-out window never runs close-navigation. */
  popout: boolean;
  /** The group id a tab belongs to (for fuse membership sync). */
  groupOf: (id: string) => string | undefined;
}

export type WorkspaceEvent =
  | { type: 'selectTab'; id: string }
  | { type: 'focusSlot'; slot: SlotId }
  | { type: 'menuSplit'; otherId: string; orientation: Orientation }
  | { type: 'dropSplit'; id: string; side: 'left' | 'right' | 'top' | 'bottom' }
  | { type: 'dropSlot'; id: string; slot: SlotId }
  | { type: 'eject'; keep?: SlotId | undefined }
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
  | { type: 'openSplit'; a: SlotRef; b: SlotRef; orientation: Orientation; focused: SlotId }
  | { type: 'dissolveP'; key: string }
  | { type: 'setSlot'; key: string; slot: SlotId; ref: SlotRef }
  | { type: 'focusSlotP'; key: string; slot: SlotId }
  /** Sync the strip order + group membership of a tab fused next to another. */
  | {
      type: 'fuseSync';
      keepId: string;
      moveId: string;
      moveGid: string | null;
      targetGid: string | null;
    }
  /** Un-mark a freshly-allocated split-slot id as seen (recycled-id hazard). */
  | { type: 'unsee'; id: string };

const kindOf = (tabs: TabMeta[], id: string): TabKind =>
  tabs.find((t) => t.id === id)?.kind ?? 'terminal';

/** A fresh terminal slot id + the effect to keep it read as fresh by reconcile. */
function freshSlot(ctx: WorkspaceCtx): { ref: SlotRef; unsee: WorkspaceEffect } {
  const id = nextFreeId([...ctx.tabs.map((t) => t.id), ctx.sessionId]);
  return { ref: { tabId: id, kind: 'terminal' }, unsee: { type: 'unsee', id } };
}

/** The fuse-sync effect for moving `moveId` next to `keepId` (order + membership). */
function fuseSync(ctx: WorkspaceCtx, keepId: string, moveId: string): WorkspaceEffect {
  return {
    type: 'fuseSync',
    keepId,
    moveId,
    moveGid: ctx.groupOf(moveId) ?? null,
    targetGid: ctx.groupOf(keepId) ?? null,
  };
}

export function decide(event: WorkspaceEvent, ctx: WorkspaceCtx): WorkspaceEffect[] {
  const activePairing = pairingOf(ctx.pairings, ctx.sessionId);

  switch (event.type) {
    case 'selectTab': {
      // A pairing MEMBER re-tiles that pairing focused on its slot; any other tab
      // shows full-width. Selection NEVER replaces a slot. chooserPage clears.
      const out: WorkspaceEffect[] = [{ type: 'chooserPage', value: false }];
      const p = pairingOf(ctx.pairings, event.id);
      if (p) {
        const slot = memberSlot(p, event.id);
        if (slot) out.push({ type: 'focusSlotP', key: p.a.tabId, slot });
      }
      out.push({ type: 'navigate', id: event.id });
      return out;
    }

    case 'focusSlot': {
      // Only the active pairing (the one on screen): a click in a full-width
      // non-member pane must never yank the view over to a hidden pairing.
      if (!activePairing || activePairing.focused === event.slot) return [];
      return [
        { type: 'focusSlotP', key: activePairing.a.tabId, slot: event.slot },
        { type: 'navigate', id: activePairing[event.slot].tabId },
      ];
    }

    case 'menuSplit': {
      // Blocked while THIS tab is already in a pairing (on screen) or on mobile.
      if (activePairing || ctx.mobileActive) return [];
      const current: SlotRef = { tabId: ctx.sessionId, kind: ctx.activeKind };
      const out: WorkspaceEffect[] = [];
      let target: SlotRef;
      if (event.otherId === ctx.sessionId) {
        // Splitting with the only/active tab spawns a fresh terminal.
        const f = freshSlot(ctx);
        target = f.ref;
        out.push(f.unsee);
      } else {
        target = { tabId: event.otherId, kind: kindOf(ctx.tabs, event.otherId) };
      }
      out.push(fuseSync(ctx, ctx.sessionId, target.tabId));
      out.push({
        type: 'openSplit',
        a: current,
        b: target,
        orientation: event.orientation,
        focused: 'b',
      });
      out.push({ type: 'navigate', id: target.tabId });
      return out;
    }

    case 'dropSplit': {
      if (activePairing || ctx.mobileActive) return [];
      // Dragging the ACTIVE tab onto its own pane is refused. A pane cannot
      // mirror itself — one PTY has one attachment — so the only thing this
      // gesture could ever do was spawn a FRESH terminal, which is not what
      // dropping a tab means anywhere else in the strip and read as a bug.
      // `menuSplit` keeps the spawn, because "Split with… (this tab)" is an
      // explicit request for a second terminal rather than a misfired drag.
      // App hides the edge zones for this tab too, so the gesture is visibly
      // unavailable; this is the guard for a drop that lands anyway.
      if (event.id === ctx.sessionId) return [];
      const orientation: Orientation =
        event.side === 'left' || event.side === 'right' ? 'row' : 'column';
      const before = event.side === 'left' || event.side === 'top';
      const current: SlotRef = { tabId: ctx.sessionId, kind: ctx.activeKind };
      const out: WorkspaceEffect[] = [];
      const dragged: SlotRef = { tabId: event.id, kind: kindOf(ctx.tabs, event.id) };
      out.push(fuseSync(ctx, ctx.sessionId, dragged.tabId));
      const a = before ? dragged : current;
      const b = before ? current : dragged;
      out.push({ type: 'openSplit', a, b, orientation, focused: before ? 'a' : 'b' });
      out.push({ type: 'navigate', id: dragged.tabId });
      return out;
    }

    case 'dropSlot': {
      // Replace a slot's content in the ACTIVE pairing (never duplicate a member).
      if (!activePairing || memberSlot(activePairing, event.id)) return [];
      const otherSlot: SlotId = event.slot === 'a' ? 'b' : 'a';
      const keepId = activePairing[otherSlot].tabId;
      const ref: SlotRef = { tabId: event.id, kind: kindOf(ctx.tabs, event.id) };
      return [
        fuseSync(ctx, keepId, event.id),
        { type: 'setSlot', key: activePairing.a.tabId, slot: event.slot, ref },
        { type: 'navigate', id: event.id },
      ];
    }

    case 'eject': {
      // Collapse the active pairing to the KEPT slot's tab (full-width).
      if (!activePairing) return [];
      const survivor = activePairing[event.keep ?? activePairing.focused].tabId;
      return [
        { type: 'dissolveP', key: activePairing.a.tabId },
        { type: 'navigate', id: survivor },
      ];
    }

    case 'tabCreated': {
      // A server-assigned id colliding with a pairing member means that member is
      // stale (died while away) — dissolve that pairing instead of focusing a ghost.
      const out: WorkspaceEffect[] = [];
      const p = pairingOf(ctx.pairings, event.id);
      if (p) out.push({ type: 'dissolveP', key: p.a.tabId });
      out.push({ type: 'chooserPage', value: false });
      out.push({ type: 'navigate', id: event.id });
      return out;
    }

    case 'sessionsBroadcast': {
      // The ACTIVE tab was closed → go to its LEFT strip neighbor, else right;
      // nothing left → the New-tab PAGE. A never-broadcast terminal is FRESH
      // (its attach hasn't spawned it), not closed. An active pairing + popouts
      // handle their own reconcile/ended state (App reconcile navigates for a
      // dead pairing member).
      if (ctx.popout || activePairing) return [];
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
