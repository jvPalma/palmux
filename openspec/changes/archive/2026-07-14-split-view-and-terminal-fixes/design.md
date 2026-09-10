## Context

split-view (unarchived, in the working tree) de-singletonized the terminal and added
a two-slot desktop split (`session/useSplit.ts`, `App.tsx`, `session/SessionTabs.tsx`,
`session/SplitDropZones.tsx`, `session/SplitDivider.tsx`, `panes/PaneHost.tsx`). It
shipped with three model/UX gaps and rides alongside two pre-existing terminal bugs:

- **Rule R** (`App.tsx` `selectTab`): while split, _any_ strip selection of a
  non-member tab calls `setSlotTab(focused, …)` and replaces the focused slot. There
  is no way to view a tab outside the split, no way to eject a tab from the split, and
  `tabCreated → selectTab(id)` therefore drags every newly-created tab into a slot.
- The strip does not indicate which slot is focused (only a subtle pane border does).
- Raw SGR mouse-report frames (`\x1b[<35;…M`, motion-tracking) can surface as visible
  text; mobile swipe-scroll misbehaves inside a mouse-reporting full-screen app under
  tmux (Claude).

Constraints: desktop-only split (unchanged), no wire-protocol change, no server change,
pure client. The split model already guarantees exactly two slots _structurally_
(`SplitState` has `a` and `b`), so "exactly two slots" is about not adding code paths
that nest — not a data-model change.

## Goals / Non-Goals

**Goals:**

- Make the split a stable 2-tile pairing that is _displayed_ only when the active tab
  is one of its members; other tabs view full-width with the split preserved.
- New tabs and non-member selections never consume a slot.
- Explicit slot replacement (drag a tab onto a slot) + explicit per-slot eject.
- The focused split slot is legible from the tab strip.
- Mouse-report frames never render as text; mobile swipe-scroll behaves under tmux.

**Non-Goals:**

- Any change to the mobile split gating (split stays desktop-only).
- More than two slots, nested/grid splits, or reordering/grouping the tab strip.
- The deferred features (markdown viewer, terminal-theme-driven webapp colors).
- Server/protocol changes.

## Decisions

### D1 — `splitShown` = split defined AND active tab is a member

Derive `splitShown = !!split && (activeId === split.a.tabId || activeId === split.b.tabId)`.
The content area renders the two-slot rect layout only when `splitShown`; otherwise it
renders the active tab full-width. `split` state persists across the hidden period, so
returning to a member re-tiles with no remount (panes stay mounted via the rect layer).
_Alternative rejected_: clearing the split when navigating away — loses the pairing and
contradicts the Chrome-like model the user chose.

### D2 — `selectTab` navigates, never replaces a slot (supersedes Rule R)

New logic: if a split exists and `id` is a member → `focusSlot(thatSlot)` + navigate; if
`id` is not a member → just navigate (`setSessionId`, split preserved but hidden). The
`setSlotTab`-on-select branch is removed. This single change also fixes the
`tabCreated → selectTab(id)` bug for free: a freshly-created id is never a member, so it
opens full-width outside the split. `doSplit`/`doDropSplit` keep using `openSplit`
directly (they intentionally build the pairing) and are unaffected.

### D3 — Slot replacement becomes an explicit drop-onto-slot gesture

`SplitDropZones` currently only opens a split when none exists. Extend it (or add
per-slot drop targets) so that _while a split is active_, dropping a strip tab onto a
slot calls `setSlotTab(slot, ref)` (which already refuses to duplicate the other slot's
tab and focuses the slot). Edge-drop-with-no-split behavior is unchanged. No third slot
is ever produced.

### D4 — Per-slot eject via a rect-positioned overlay, not inside the pane

Eject must work for every tab kind (terminal + web/dashboard/editor), so it lives in an
App-owned overlay positioned by slot rect (same pattern as `SplitDivider`), not inside
`TerminalPane`/`PaneHost`. Each slot gets a small eject control → `doCollapse(keep=other)`
(the `collapse(keep)` hook API already exists; ejecting slot A keeps B, and vice-versa).
Neither tab is closed. The divider's existing collapse-to-focused control (`⧉`) is
removed as redundant with per-slot eject; the orientation toggle stays.

### D5 — Strip focus indicator driven by `split` members + `focused`

`SessionTabs` receives the two member ids and the focused member id. When `splitShown`,
the focused member's strip item gets a strong accent and the other member a subtle
"paired" marker; the indicator moves with `focusSlot`. When the split is hidden (active
tab outside) the two members keep a light paired marker so the pairing stays discoverable
(see OQ1). Collapsing clears all markers. Styling in `index.css`; no new component.

### D6 — Mouse-report leak (item 1): reproduce-then-gate at the identified boundary

Root cause is unconfirmed. `35;94;41M` is an SGR motion frame (button 35 = 32 motion +
3 none), which our `encodeMouseSGR` never emits (it only sends 0/64/65) — so the source
is xterm's native mouse handling or an output-side path, not our touch code. Approach:
(1) reproduce with motion-tracking active (desktop mouse move in a mouse-reporting app,
and the mobile case) while logging both `onData` (client→pty input) and the pty→display
`instance.write` path to locate where the bytes render as text; (2) fix at the origin;
(3) defense-in-depth: guarantee no code path passes SGR mouse-report bytes to
`instance.write()`, and that the `onData` gate classifies mouse frames as input-only.
The likely touch points are `TerminalPane.tsx` (`REPORT_RE`/`onData`) and `touch.ts`.
Requirement is outcome-based (never rendered as text) so the fix follows the evidence.

### D7 — Mobile swipe-scroll under tmux (item 5): reproduce-then-tune targeting

`useMobileGestures` maps a swipe to wheel frames via `touch.ts` `encodeWheel`
(`encodeMouseSGR(64|65).repeat(|lines|)`), gated by `isMouseReporting`. Under tmux + a
full-screen app, the wheel either over-scrolls (too many repeated frames), lands in tmux
copy-mode, or targets the wrong cell. Approach: reproduce on mobile with tmux+Claude;
determine whether frames reach the app or tmux; then correct the swipe→lines mapping
and the target cell (send at the touched cell, clamp frame count), keeping the
`isMouseReporting ? app-wheel : local-scrollback` fork. Touch points: `useMobileGestures`,
`touch.ts`.

## Risks / Trade-offs

- **[D2 reverses a shipped default (Rule R)]** → split-view is not yet committed/archived;
  the change is additive in the working tree and the user reviews before committing.
  Documented as **BREAKING** in the proposal.
- **[D1 display-scoping interacts with focus/URL sync]** → the URL reflects the active
  tab (member or not); when hidden, `focused` is retained so re-tiling restores the last
  focused slot. Covered by split-layout scenarios; add a regression test for
  navigate-away-and-back.
- **[D6/D7 are evidence-driven, not pre-solved]** → risk of scope creep. Mitigate by
  timeboxing repro and shipping the outcome (no visible frames / correct scroll target)
  even if the minimal fix is a boundary gate rather than a deep xterm change.
- **[Per-slot eject overlay adds hit-targets over panes]** → keep the control small,
  corner-anchored, and `pointer-events` scoped so it doesn't steal terminal clicks;
  mirror the divider's existing overlay hit-testing.

## Migration Plan

Pure client change layered on the working tree. Deploy with `yarn build` +
`yarn service:update` (or via the new `./restart.sh`). Rollback = revert the diff; no
persisted-state migration (the `palmux-split` localStorage shape is unchanged — `focused`
and the two slot refs already exist). No server or protocol coordination.

## Open Questions

- **OQ1**: When the split is defined but hidden, do we keep a persistent "paired" marker
  on both member tabs in the strip? Proposed default: yes, subtle. Cheap to drop.
- **OQ2**: Items 1 and 5 root causes are confirmed only at repro time; the specs are
  outcome-based and the design commits to investigate-then-fix. If repro shows the leak
  is app/tmux-originated (outside our control), we gate defensively and document the
  boundary.
- **OQ3**: Keep or drop the divider's collapse-to-focused `⧉` once per-slot eject exists?
  Proposed: drop it to avoid two overlapping "collapse" affordances.
