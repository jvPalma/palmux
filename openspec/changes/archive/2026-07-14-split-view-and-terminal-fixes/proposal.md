## Why

The freshly-built split-view feature shipped with real UX gaps and one model-level
correctness bug: a tab pulled into a split can't be removed, the tab strip gives no
sign of which split slot is focused, and creating/selecting tabs while split
silently consumes a slot instead of leaving the split intact. Two pre-existing
terminal bugs ride along: raw SGR mouse-motion sequences (`\x1b[<35;…M`) can render
as visible garbage text, and swipe-scroll misbehaves on mobile inside a full-screen
TUI (Claude) running under tmux. These are the "make the thing we just built
actually usable" fixes, done before split-view is committed and archived.

## What Changes

- **Split is a stable 2-tile pairing, displayed only when the active tab is one of
  its two tabs.** Selecting/opening any other tab shows that tab full-width with the
  split preserved (re-tiles on return). **BREAKING** relative to split-view's Rule-R
  default: clicking a non-split strip tab no longer replaces a slot.
- **New tabs are always created OUTSIDE the split.** `[+]` / `tabCreated` no longer
  routes through slot-replacement; the new tab is shown full-width, split preserved.
- **Slot replacement becomes an explicit gesture**: drag a strip tab onto a slot to
  swap that slot's content (still exactly two slots — never nests, never a 3rd slot).
- **Per-slot eject**: a control on each split slot removes it, collapsing the split
  and showing the other slot's tab full-width (no 1-slot split state exists).
- **The tab strip marks the focused split slot** so slot A vs slot B is legible from
  the strip, not only from the subtle pane border.
- **Uncaught mouse-report sequences never render as visible text** — the leaking
  `\x1b[<…M`/`m` SGR mouse frames are gated/handled at the terminal boundary.
- **Mobile swipe-scroll targets the correct context** when a mouse-reporting
  full-screen app runs inside tmux, instead of scrolling the wrong surface.

## Capabilities

### New Capabilities

- `terminal-mouse-gating`: uncaught SGR mouse-report sequences are prevented from
  rendering as visible text at the terminal I/O boundary.
- `mobile-scroll-fix`: swipe-to-scroll resolves the correct scroll target under
  nested mouse-reporting apps (tmux hosting a full-screen TUI).

### Modified Capabilities

<!-- These build on the still-unarchived split-view change; expressed as additive
     requirements that supersede split-view's Rule-R default where noted. -->

- `split-layout`: split display is scoped to its two tabs; exactly-two-slot
  invariant; new tabs created outside the split; per-slot eject; focused slot
  reflected in the tab strip.
- `split-dnd`: dragging a strip tab onto an existing slot replaces that slot's
  content (in addition to the existing edge-drop-to-open-a-split gesture).

## Impact

- **Client**: `session/useSplit.ts` (invariants, eject-keeps-other), `App.tsx`
  (`selectTab` no longer slot-replaces; `tabCreated` creates outside split; content
  render scoped to split membership; eject wiring), `session/SessionTabs.tsx`
  (focused-slot styling; split-pair affordance; drag-onto-slot source),
  `session/SplitDropZones.tsx` (accept drops while split active → replace slot),
  `session/TerminalPane`/`panes` (per-slot eject control), `index.css` (strip focus
  styling, eject affordance).
- **Terminal**: `terminal/TerminalPane.tsx` `REPORT_RE`/`onData` gate and/or
  `terminal/touch.ts` (mouse-frame gating), `mobile/useMobileGestures.ts` +
  `terminal/touch.ts` (swipe-scroll targeting).
- **No wire-protocol changes**; no server changes expected (all client-side).
- **Docs/tips**: `tips/tips.ts`, `README.md`, `CLAUDE.md` split-view section.
