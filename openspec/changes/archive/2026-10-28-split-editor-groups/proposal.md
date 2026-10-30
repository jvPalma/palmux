# Proposal

## Why

palmux's split view shows at most two tabs, as a pairing drawn as one fused pill in a single top strip. The
owner works with more than two things at once and wants the split to behave exactly like VS Code's editor
groups (owner, 2026-10-27, with a screen recording of VS Code as the reference). Today's model cannot grow
into that: a pairing has exactly two slots by requirement, and every rule around it (fusion, adjacency,
shared group membership, eject, slot replacement) exists only to make two tabs look like one.

## What Changes

**The objective, in plain words:** the content area on a desktop becomes a grid of panes. Each pane has its own
row of tabs and shows one of them. You make a new pane by dragging a tab to the edge of a pane, and the tab moves
into it. A pane that loses its last tab disappears and its neighbours take the space.

**How it works today and its limits:** `useSplit` stores pairings of exactly two tabs; only the active pairing
is tiled; the pairing is one fused pill in the one top strip; its members must stay next to each other in the
strip and share a colour group; a pane can be ejected, swapped, rotated or have its slot replaced. Three, four
or nested panes are impossible.

**What is new:**
- **Editor groups.** The desktop content area is a layout tree of panes (columns, rows inside columns, nested to
  any depth), separated by draggable sashes. Every tab belongs to exactly one pane.
- **A tab strip per pane.** Each pane draws its own pill strip, with the same pills, colour dots, colour-group
  clusters, context menu and `+` as today's strip. The single top strip is removed.
- **Drag a tab to make a pane.** Dragging a tab over a pane shows a preview: the left, right, top or bottom half
  for an edge drop (a new pane on that side, the tab moved into it), the whole pane for a centre drop (the tab
  moved into that pane). Dropping on another pane's strip also moves the tab there; it keeps its place in the
  server order (a positional cross-pane drop is a follow-up).
- **A small pure layout model.** Three operations over a tree: add a pane beside another, remove one and collapse
  its parent, resize two siblings with today's 15% clamp. VS Code's MIT-licensed `grid.ts getRelativeLocation` and
  `gridview.ts removeView` collapse rule are the reference and are attributed where their logic is copied; nothing
  else of VS Code is ported. palmux keeps its own rendering, in which no pane is ever moved in the DOM.
- **Split right / Split down** (tab menu, keybindings Ctrl+Shift+D / Ctrl+Shift+E) move the tab into a new pane on
  that side. On a pane's only tab they open a new terminal in the new pane instead.
- **New tabs open in the focused pane** and become its active tab.
- The layout is saved **per window** (sessionStorage). The window's selected tab (`browser-local-tab-selection`)
  stays the focused pane's active tab and is unchanged; a fresh window or a relaunched app opens one pane on the
  device's last tab. No device-wide layout copy in v1: inheriting N panes would attach N terminals at once and
  evict them from any other open window.
- **Removed (BREAKING for the split UI only):** the fused split pill, pairings, slot eject (⏏), divider swap
  (double-click) and rotate handle, drop-onto-slot replacement, the `toggleSplitOrientation` keybinding, and the
  `palmux-splits` / `palmux-split` stores (ignored, a fresh layout starts with one pane).

**Who it affects:** desktop users of palmux. Phones are unaffected: the mobile layer shows one pane, as today.
No server change: tab order, colour groups and names stay server state; which pane holds which tab is browser
state.

**Main risks:**
- Remounting a terminal (it reads as a rival client, "Opened somewhere else") or reparenting an iframe or Monaco
  (they reload) while panes are added and removed. The design renders every pane, strip, sash and drop overlay as
  flat absolutely positioned siblings computed from the tree, and keys a terminal by its PANE.
- A restored multi-pane layout mounting before the first `sessions` broadcast would spawn shells on stale ids.
  Nothing mounts until the restored layout is reconciled against that broadcast.
- WebGL context limits: one xterm per pane (not per tab), so the count of contexts is the count of terminal panes.

**How success is measured:** on a desktop at 1440 px, the recording's sequence works end to end: one pane with five
tabs; a tab dragged to the right edge makes two panes; another makes three columns; a bottom-edge drop makes a row
inside a column; sashes resize; moving the last tab out of a pane removes the pane. Across all of it, no terminal
shows "Opened somewhere else", no iframe or editor reloads (the existing one-mount tests ported to groups), and
a reload restores the layout. The full client and server test suites, `yarn typecheck` and `yarn lint` pass.

**Scope:** desktop layout, per-pane strips, drag-and-drop between panes, sashes, split commands, persistence,
reconcile against broadcasts, colour-group behaviour per pane, docs.

**Out of scope / non-goals:**
- The same tab in two panes at once (VS Code allows a document in two groups). A terminal has one live client
  (last attach wins) and a pane tab has one DOM node, so moving is the only operation.
- Dragging a whole pane, maximising or locking a pane, equalise-all, floating or popped-out groups.
- New keyboard chords for focusing or moving between panes (a later change; VS Code's Ctrl+\ and Ctrl+K belong to
  the shell inside a terminal).
- Any server, protocol or `tabs.json` change; syncing layouts between windows or devices.
- Migrating old pairings into the new layout.

## Capabilities

### New Capabilities
- `editor-groups`: the desktop pane grid: the layout tree, one pane per group with its own strip, sashes, drag to
  create or move, split commands, focus, persistence per window, reconcile against the server's tab list, and the
  desktop-only rule.

### Modified Capabilities
- `split-layout`: retired. Every requirement is removed; the surviving rules (desktop only, clamped resize applied
  on settle, closing collapses the space) are restated for N panes in `editor-groups`.
- `split-fusion`: retired. Fused pills, pairing adjacency and membership adoption have no counterpart.
- `split-dnd`: retired. Edge drops and previews are restated per pane in `editor-groups`; slot replacement is gone.
- `tab-reorder`: strip drag reorders inside a pane's strip and maps the drop to the full server order; the split
  member scenarios go.
- `tab-grouping`: a colour group may span panes and each pane draws its own cluster; the collapse guard runs per
  pane; the pairing membership rule goes.
- `chrome-tab-strip`: the strip lives in each pane, not in a topbar; the app menu button moves to the top of the
  dock rail in every display mode; overflow no longer mentions fused pills.
- `sidebar-dock`: the rail order gains the app menu button above New tab.
- `window-pop-out`: popping out a tab in a pane keeps the pane, showing the taken-over state.

## Impact

- **Client code:** `session/useSplit.ts` replaced by `session/pane-grid.ts` (pure model, ported VS Code maths with
  its MIT header) and `session/useEditorGroups.ts`; `session/SplitView.tsx` becomes `session/GroupsView.tsx`;
  `SplitDivider.tsx` becomes a sash; `SplitDropZones.tsx` becomes a per-pane drop overlay; `SlotDropZones.tsx`
  deleted; `SessionTabs.tsx` and `tab-groups.ts` lose the fused branch; `workspaceController.ts`, `App.tsx`,
  `SplitFocusContext.ts`, `DockPanel.tsx` (app menu), `keybindings.ts`, `tips.ts`, `index.css`, CLAUDE.md.
- **Server, protocol, persistence files:** unchanged.
- **Dependencies:** none added. dockview, FlexLayout, allotment, react-mosaic, golden-layout and rc-dock were
  evaluated and rejected: they reparent panes, own the tab chrome, assume one panel per tab, or are unmaintained
  (details in design.md D1).
- `pwa-window-controls` needs no delta: in window-controls-overlay mode the top chrome is an empty drag region laid
  out in the title-bar area, which its requirement already covers.
- **Decisions confirmed by the owner on 2026-10-27 (all four kept, each option A of the mock review):** the app menu moves to the top of the dock rail and the
  topbar goes away; old split layouts are discarded; collapsing a colour group switches every pane whose active tab
  is a member; a relaunched PWA opens one pane (no device-wide layout copy in v1); a cross-pane strip drop keeps the
  server order.
