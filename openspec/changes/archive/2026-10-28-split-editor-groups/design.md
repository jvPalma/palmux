# Design

## Context

Today's split (read before changing anything; CLAUDE.md "Split view", "Split fusion", "A terminal pane is keyed by
SLOT", "Split gestures live on the divider"):

- `session/useSplit.ts` (398 lines) stores pairings `{a, b, orientation, ratio, focused}` in
  `localStorage['palmux-splits']` (`{v:2}`), reconciles them on every broadcast (`reconcilePairings`), and gives
  `splitRects(orientation, ratio)` two percent rects.
- `session/SplitView.tsx` (282) renders at most two `TerminalPane`s keyed by slot `a`/`b`, one `PaneHost`
  (`panes/PaneHost.tsx`, 132: every non-terminal tab mounted once under `.pane-host`, positioned by a percent `Rect`,
  `display:none` when in no rect), a `SplitDivider` and drop zones. Everything is a flat child of `.content-area`.
- `session/SplitDropZones.tsx` (71) shows four fixed edge bands; `SlotDropZones.tsx` replaces a slot.
- `session/SessionTabs.tsx` (1115) is the single top strip; it carries the fused-pill branch (`pairings` prop, l.45-47,
  569-686), split menu items (l.907-936) and drop maths over its own rendered list. The drag payload is
  `dataTransfer` (`TAB_DND_TYPE = 'application/x-palmux-tab'`, l.37; read at l.451), so a drop works across strip
  instances.
- `session/tab-groups.ts` `buildStrip` (l.107-155) builds chips/clusters over whatever list it is given;
  `planFusions` (l.85-105) and its `pairings` parameter exist only for fusion.
- `session/workspaceController.ts` is a pure `decide(event, ctx) → effects` (l.112) with events for pairings
  (`menuSplit`, `dropSplit`, `dropSlot`, `eject`, `fuseSync`) and close-navigation that bails while a pairing is
  active (l.245).
- `session/SplitFocusContext.ts` holds a `{a, b}` registry of `PaneApi`s; its API is already slot-generic.
- `session/window-selection.ts` keeps the window's selected tab in `sessionStorage['palmux-window-tab']` with a
  device fallback `localStorage['palmux-last-tab']` written only on a real change, and stores `kind` to detect
  recycled ids.
- `App.tsx` (2770) wires all of it: `useSplit(!mobileActive && !popout)` (l.702), the topbar with `SessionTabs` and
  the app menu button (l.2337-2378), `SplitView` (l.2385), and `DockPanel` (l.2487).
- The server keeps one ordered tab list and contiguous colour groups (`reorderTabs`, `groupUpdate`,
  `normalizeOrder`); one live client per terminal (last attach wins, `pty.ts`).

Reuse research (two reviews, 2026-10-27): VS Code's `vs/base/browser/ui/grid` reparents views on every split and
merge (`SplitView.doAddView` appends the view into a new wrapper; `GridView.addView` rebuilds branches) and pulls
~12k lines of `vs/base`. Its tree ALGEBRA is pure and small.

## Goals / Non-Goals

**Goals:**
- N panes in a nested row/column tree, a strip per pane, VS Code drop regions, sashes, VS Code close behaviour.
- Keep the two invariants that protect live state: a terminal is keyed by its pane; no pane is ever reparented.
- No server or protocol change.

**Non-Goals:**
- The same tab in two panes; dragging whole panes; maximise/lock/equalise; floating groups; layout sync across
  windows or devices; new focus/move chords; migrating old pairings.

## Decisions

### D1. A small pure layout model, VS Code's rules as the reference; keep palmux's rendering

`session/pane-grid.ts` (new, no React, no DOM) holds:

```ts
export type Orientation = 'row' | 'column';            // row = children side by side
export interface TabRef { id: string; kind: TabKind }
export interface PaneLeaf { type: 'leaf'; id: string; tabs: TabRef[]; active: string | null; size: number }
export interface PaneBranch { type: 'branch'; orientation: Orientation; children: PaneNode[]; size: number }
export type PaneNode = PaneLeaf | PaneBranch;
export interface PaneLayout { v: 3; root: PaneNode; focused: string; nextId: number }   // focused = a leaf id
export type Side = 'left' | 'right' | 'top' | 'bottom';
```

`size` is the node's fraction of its parent's main axis; siblings sum to 1. Operations (all pure, returning a new
layout, never mutating):

Every operation that can change a leaf's active tab takes `order: string[]` (the server's full tab order from the
current broadcast), because the neighbour rule reads the strip, which is server order filtered to the leaf.

- `splitPane(layout, targetLeafId, side, tab, order)`: mints the new leaf id from `nextId`. VS Code's `getRelativeLocation` + `addView` with
  `Sizing.Split`: if the target's parent has the drop's orientation (`left/right` → `row`, `top/bottom` → `column`),
  insert the new leaf as a sibling before/after the target and halve the TARGET's size between the two; otherwise
  replace the target with a branch of that orientation holding `[target, new]` or `[new, target]`, each size 0.5,
  the branch taking the target's old size. The tab is removed from its source leaf first (`removeTab(…, order)`). If the target is the tab's own leaf and it is
  that leaf's only tab, the layout is returned unchanged.
- `removeTab(layout, tabId, order)`: drop it from its leaf; if the leaf was showing it, the new active is its left
  neighbour in that leaf's SERVER-ORDERED strip, else its right (`neighborAfterClose` semantics, computed by the
  caller passing `order`); if the leaf is now empty and is not the only leaf, `removeLeaf`.
- `removeLeaf(layout, leafId)`: VS Code's `removeView` collapse: give the leaf's size to its siblings in proportion
  to their sizes; a branch left with one child is replaced by that child (which takes the branch's size; if the
  child is a branch of the same orientation as the grandparent, its children are spliced into the grandparent with
  sizes multiplied by its size); a lone root branch child is promoted to root. Focus changes ONLY when `focused === leafId`: it then moves to the
  sibling that was adjacent (the one after it, else before), descending to its first leaf. Removing a pane another
  window emptied never moves this window's focus.
- `moveTab(layout, tabId, targetLeafId, order)`: `removeTab` then append to target, make it active, focus target. A move to
  its own leaf only activates it.
- `resizeSash(layout, branchPath, index, deltaFraction)` (`deltaFraction` is a fraction of the BRANCH's main axis): two siblings `index` and `index + 1` of one branch only
  (today's divider rule, not VS Code's multi-view priority resize): clamp so each stays ≥ 0.15 of the branch, apply,
  keep the sum at 1.
- `layoutRects(layout) → { panes: Map<leafId, Rect>; sashes: Sash[] }`: recursive walk in percentages of the
  content area (`Rect` = `{left, top, width, height}` in %, the shape `PaneHost` already takes). `Sash` =
  `{ path: number[]; index: number; orientation; rect; branch: Rect }`; `branch` is the parent branch's rect, so the
  component can turn pointer pixels into a branch fraction.
- `reconcile(layout, tabs, prevOrder, pending) → layout`: D6.
- `parseLayout(raw) → PaneLayout | null`: D5; rejects anything that fails shape checks (unknown type, sizes not
  finite or ≤ 0, a tab id in two leaves, `focused` not a leaf, an unknown kind, `nextId` not an integer greater than
  every minted leaf number).

Leaf ids are minted `p` + a base-36 counter kept in the layout (`nextId`), never derived from a tab id (today's
pairing key `a.tabId` is renamed by swap; `useSplit.ts` l.357-360 documents that hazard).

Only two pieces of VS Code logic are copied: the side → sibling-or-wrap decision of `grid.ts getRelativeLocation`
(used by `splitPane`) and the sibling-collapse rule of `gridview.ts removeView` (used by `removeLeaf`). Those two
functions carry a comment naming their source and VS Code's MIT notice ("Copyright (c) Microsoft Corporation.
Licensed under the MIT License."). Sizing modes, snapping, hidden views and layout priority are not ported.

**Alternatives rejected:** dockview (its `renderer: 'always'` keeps panels in place, but a panel is a tab, so one
xterm per tab and Chromium's ~16 WebGL contexts; it replaces `SessionTabs` and its ~900 tests, owns its DOM, ships
10 CSS transitions and 125 colour variables, 90 KB gzip); FlexLayout (does not reparent, but the same panel = tab
and chrome ownership); allotment (splits only, React-tree nesting remounts moved panes); react-mosaic (react-dnd stack
conflicts with the native strip drag); golden-layout (unmaintained since 2022); rc-dock (reparents); extracting VS
Code's grid verbatim (reparents, 12k lines of `vs/base`); writing the algebra from scratch (VS Code's is
battle-tested and the port is ~350 lines).

### D2. Flat rendering from rects; terminals keyed by pane

`session/GroupsView.tsx` replaces `SplitView.tsx`. Its one root is `.groups-view` (`position: absolute; inset: 0` inside `.content-area`, so it is the positioned
ancestor of everything below, `PaneHost`'s `inset: 0` included; the inline `--group-strip-h: 0px` of `strips={false}`
lands on it). Inside it, as flat absolutely positioned siblings and direct children of the root, in this order: for each leaf its strip box (`.group-strip`, top `STRIP_H` of the pane rect), its
terminal pane if the active tab is a terminal (`TerminalPane` with `key={leafId}` and `slot={leafId}`, inside an
`ErrorBoundary` that is ALSO `key={leafId}` (`label="Terminal"`), and whose `style` is the
fallback-only rect; a key carrying the tab id remounts the terminal on every switch, which `SplitView.tsx` l.172-193
records as the "Opened somewhere else" bug), one `PaneHost` for all
non-terminal active tabs (`rects[tabId]` = the pane rect; `PaneHost` takes `bodyOffset: boolean` and places each child with `rectCss(r, bodyOffset)`, which emits `top: calc(<top>% + var(--group-strip-h))` and `height: calc(<height>% - var(--group-strip-h))` when `bodyOffset` is true and plain percentages otherwise), one `GroupDropOverlay` per leaf while a tab drag is
active, and one `Sash` per sash rect. The tree is never rendered as nested elements: nesting would reparent
`PaneHost` children on every split or merge and reload iframes and Monaco.

The body rect is the pane rect minus the strip height; `--group-strip-h` = `calc(var(--ctl-h) + 2 *
(var(--cluster-pad) + 1px))` (the strip's existing min-height), declared on `.content-area` and read by
`.group-strip` and by the body offsets, so the rect maths stays percentage-only and the strip height is a token, not
a number in JS. `--cluster-pad` moves from the strip rule to `:root` so `.content-area` can resolve it. With
`strips={false}` (mobile, pop-out) `GroupsView` sets `--group-strip-h: 0px` inline on its root and draws no strip.
With `chooserPage` it renders only the single leaf's strip and nothing in the body (App draws the New-tab page there,
as today).

A single pane renders exactly the same elements (one strip, one body): there is no separate single-pane path.

### D3. One order: the server's

A pane strip renders `tabs.filter(t => leaf has t.id)` in broadcast order. There is no per-pane order. A strip drop
of a tab ALREADY in pane P goes through `doReorder(leafTabIds, id, index, joinGid, anchor, boundary)`: it builds P's
visible entries with `visibleEntries(tabs.filter(in P), collapsed)`, resolves `beforeId` = the entry at `index` in
that list (past P's last entry: the id after P's last tab in the FULL order, else append), maps it to the full-order
insertion index `applyDrop` already takes, and resolves `joinGid` and `anchor` against the full list exactly as
today. A strip drop of a tab from ANOTHER pane is a membership move only (`moveTab`, no `reorderTabs`): the
tab appears at its server-order position among P's tabs. A positional cross-pane drop is a follow-up.

### D4. `SessionTabs` becomes the pane strip

`SessionTabs` stays one component, rendered once per leaf, minus the fusion code: the `pairings` prop, the fused
item branch, `focusedByA`, and `onSplit`'s "while already split" gating are removed. New props: `paneId: string`,
no focus prop: `GroupsView` puts `group-strip-focused` on the focused leaf's `.group-strip` box, the element that carries
the 1px `border-bottom`, which then takes `--t-accent` (nothing animates),
`onSwitch(id)` keeps its name and now means activate in this pane and focus it, `onDropFromOtherPane(id)` (a drop of a tab NOT in this
pane's list, anywhere on the strip: App performs `moveTab` only, D3). Close-many ("Close other tabs", "to the
right") is unchanged: it stays computed from the FULL server tab order, across every pane (owner, 2026-10-27). `buildStrip` loses `planFusions` and the `pairings` parameter.

### D5. Persistence per window only; the selection store stays

Key: `sessionStorage['palmux-layout']`, `JSON.stringify(PaneLayout)`, written on every committed change (settle-only
for sashes); storage exceptions are swallowed. There is NO device-wide layout copy: a fresh window or a relaunched
PWA starts with one leaf holding every tab, active = the tab `resolveSelection` picks today (own selection, else
`palmux-last-tab`, else the first tab). Inheriting N panes would attach N terminals and evict them from any other
open window (last attach wins); a device copy is a follow-up if relaunch loss is reported.

The layout answers "which pane holds which tab"; `window-selection.ts` keeps answering "what is this window
showing". `palmux-splits` and `palmux-split` are never read again and are not deleted (a rollback to the old client
still finds them). Pop-outs and the mobile layer neither read nor write `palmux-layout`.

**The layout is the source of truth for the selection while groups are enabled.** App renames its state setter to
`setSessionIdRaw` and defines one choke point, `setSessionId(id)`: with groups enabled it calls `groups.show(id)`;
otherwise it calls `setSessionIdRaw(id)` as today. Every existing navigation path (`showTab`, the controller's
`navigate` effect from `selectTab` / `tabCreated`, close-navigation, pop-out return, `openFileTab`, `openReview`)
already goes through `setSessionId`, so none of them changes. An effect `[enabled, focusedActive]` calls
`setSessionIdRaw(focusedActive)` when enabled, which makes `sessionId` a reading of the layout. The choke point
resolves the kind from `tabsRef.current` (the freshest list, ahead of the render) and calls `show({ id, kind, known })`
with `kind ?? 'terminal'` and `known` = the id is in that list. `show`: if a leaf holds `id`, activate it there and
focus that leaf; otherwise add `{id, kind}` to the focused leaf as active, and put `id` in `pending` only when
`known` is false (D6). A server-created tab (editor, review…) is always known by the time its `tabCreated` arrives,
because the server broadcasts `sessions` before it answers (`server.ts` createTab → `listChanged()`), so it is never
mistaken for a pending terminal.

`show` before `ready` (the layout is still `null`) is recorded in `bootShowRef` and applied on the first ready render
as the selection: that is how `?new=1` (whose terminal is created inside the first `sessions` handler, before that
broadcast has rendered) and a legacy `/<id>` reach the layout. A legacy boot calls `setSessionId(boot.id)` in the boot
effect (`App.tsx` l.735-741), since nothing else calls `show` for it. `known` is re-evaluated against the first list
when `bootShowRef` is applied: a live legacy tab is activated where it is and never enters `pending` (so it keeps the
kind check); a legacy id the list does not hold is today's fallback: a pending terminal whose attach spawns it.

`bootSelection` is passed only from the `awaitingResolve` branch and only when the stored selection resolves to a live
tab of the stored kind; otherwise it is `null` and the restored layout's own `focused` and `active` stand (today's
`resolveSelection` answers `tabs[0]` for an unusable value, a guess that must not override a valid restored focus).
With groups enabled the `awaitingResolve` branch therefore calls `showTab` only when `resolveStoredSelection` answers,
or when no saved layout exists (then `resolveSelection`'s pick seeds the single leaf as today), and keeps
`setChooserPage(true)` for an empty list; with groups disabled it keeps today's `showTab(resolveSelection(...))`.
`window-selection.ts`'s private `isKind` omits `'review'`, so a window focused on a review always resolved as
unusable; it is replaced by the shared `isTabKind`. When `bootSelection` is set, the leaf holding it becomes focused
with it active; if no leaf holds it, it joins the focused leaf. With no restored layout, the single leaf's active is
`bootSelection ?? resolveSelection(...)`, as today.

The `[enabled, focusedActive]` effect writes `sessionIdRef.current` before `setSessionIdRaw` (the ref is what
`switchSession`, `dispatch`, `createTab`'s exclude and `toggleGroup` read, App.tsx l.492), and it skips `null`, so the
chooser page keeps the dead id exactly as the persist effect expects. `sessionId` never feeds back into the layout
after boot, so there is no loop.

### D6. Reconcile on every broadcast

`reconcile(layout, tabs, prevOrder, pending)`:
1. Drop every `TabRef` whose id is not in `tabs` or whose kind differs (recycled id), EXCEPT an id in `pending`.
   `pending` is the set of ids this window put into the layout that no broadcast has listed yet: a terminal the
   client picked an id for (`createTab` with `nextFreeId`, a lone-tab split) exists on the server only after its
   pane attaches, so dropping it would unmount the pane that is about to create it. An id leaves `pending` the first
   time a broadcast lists it. At boot `pending` is empty, so a saved terminal that is gone is dropped and never
   attached. `pending` replaces the controller's `unsee` effect and the `seenTermIds` exception for split slots.
2. Fix each leaf's `active`: if it was dropped, take the neighbour rule of D1 against `prevOrder` (the order before
   this broadcast; `neighborAfterClose` needs it), or against the new order when `prevOrder` is empty (boot).
3. Remove empty leaves (`removeLeaf`), keeping at least one leaf.
4. Add every tab no leaf holds to the focused leaf, NOT active.
5. Every leaf that shows none of its tabs (or an active that is not among them) takes its first tab in server order,
   EXCEPT a BLANK window: one leaf after step 3 that is empty or already had `active: null` before this broadcast. It
   keeps `active: null` on this and every later broadcast: tabs another window created appear in its strip and do not
   become its selection, as today (a window on the New-tab page stays there). Without the second half a title broadcast
   would select the foreign tab one broadcast later. At boot only, with or
   without a saved layout, and neither a `bootSelection` nor a boot `show`, a focused leaf left with tabs and no active takes its
   first tab in server order (every saved tab died). This is never keyed on an empty `prevOrder`. A pending id whose kind the new list now states takes that kind.

`commit` and `setLive` reconcile the layout they are given against the list the held layout was last reconciled
with before storing it, so a layout computed from a stale capture (a sash drag's start layout, a stale closure) can
never bring back a tab a broadcast removed.

Reconcile is idempotent, returns the SAME layout object when nothing changed (a title broadcast arrives every
300 ms and must not re-persist or re-render the strips), and never creates tabs or sends anything. It owns per-pane close-navigation; the
controller's `sessionsBroadcast` keeps only "the last tab went → `chooserPage`" while groups are enabled, and its
current neighbour logic for the mobile layer.

### D7. Creation, commands and focus

- A strip's `+` first focuses its leaf, then opens the New-tab chooser, so every creation path targets "the focused
  leaf" and none needs a request-to-answer correlation. A terminal is placed at once: `createTab` picks the id with
  `nextFreeId` (excluding every id in `tabs` and in the layout) and calls `selectTab(id)`, which reaches `show(id)`
  and adds it to the focused leaf as pending. A server-created kind (editor, review, web, markdown, dashboard)
  appears either in a broadcast first (reconcile step 4 puts it in the focused leaf, inactive) or as the
  `tabCreated` answer first; the answer's `navigate` reaches `show(id)` and activates it wherever it is. If the user
  focuses another pane between the request and the answer, the tab opens in the pane focused when it arrives
  (accepted; VS Code opens in the active group too).
- Opening a file or review that is already open (`openFileTab`, `openReview`) selects it, which `show(id)` turns into
  activating it in its own leaf and focusing that leaf.
- `splitRight` / `splitDown` (keybindings `Ctrl+Shift+D` / `Ctrl+Shift+E`, unchanged chords) and the tab menu items
  call `splitPane(tab's leaf, 'right' | 'bottom', tab, order)`. When the tab is its leaf's only tab, the controller
  returns `{ type: 'splitLone'; leafId: string; side: Side }` and App applies it as: id = `nextFreeId(…)` as above,
  `splitPane(leafId, side, { id, kind: 'terminal' }, order)`, add `id` to `pending`, delete it from `seenTermIdsRef`.
- `toggleSplitOrientation` is deleted from `keybindings.ts`; `loadBindings` already ignores unknown persisted ids
  (it iterates `ACTIONS`).

### D8. Drop overlay: VS Code's regions

`session/GroupDropOverlay.tsx` (replaces `SplitDropZones.tsx`), one per leaf, covering the pane body rect, mounted
only while `dragTabId` is set (a `TAB_DND_TYPE` drag; group-chip and file drags never show it). On `dragover` it
computes the region from the pointer's position in its own box (VS Code `editorDropTarget.positionOverlay`,
horizontal preferred): `x < w/3` → left, `x > 2w/3` → right, else `y < h/3` → top, `y > 2h/3` → bottom, else centre.
Preview: a `.group-drop-preview` child covering the matching half (`left: 0..50%` etc.) or the whole box for centre,
tinted with the existing `.split-drop-preview` tokens, no transition. `drop` → `onDropEdge(leafId, side)` or
`onDropCentre(leafId)`. A drop that would change nothing (a lone tab on its own pane's edge or centre) shows no
preview. Pointer `dragleave` out of the box clears the preview.

### D9. Sashes

`session/Sash.tsx` generalises `SplitDivider.tsx`: positioned by the sash rect (8px hit area centred on the
boundary), pointer capture, rAF-throttled `onDrag(deltaFraction)` with `deltaFraction = (pointer − down) px ÷
(branch main-axis % × content-area px ÷ 100)`, cumulative from pointerdown, so it is applied to the layout captured at drag start (`setLive(resizeSash(startLayout, …))`), never to the live one, or the deltas compound per frame; `onSettle` commits the layout (persist
+ one resize per terminal: `GroupsView` passes `resizePaused={sashDragging || resizeBusy}` to every `TerminalPane`
and on settle runs `requestAnimationFrame(() => registry.forEachApi((a) => a.refit()))`, as `SplitView` does today). The double-tap swap, the rotate handle and
their CSS are deleted. While a sash is dragged, `.content-area` takes `data-sash-drag="true"` and
`.content-area[data-sash-drag='true'] iframe { pointer-events: none }` (VS Code `sash.ts` does the same).

### D10. Focus and the registry

`SplitFocusContext` keeps its API; its store becomes `Map<string, PaneApi>` keyed by leaf id; `SlotId` becomes
`string`; `createSplitRegistry` starts with no focused slot (`null`, so `focusedApi()` is `null` until App sets it)
and gains `forEachApi(fn)`. The App sites that name `'a'` / `'b'` today (`setFocusedSlot(activePairing?.focused ??
'a')`, `apiFor('a')?.term() ?? apiFor('b')`, the font and theme refresh loops) become `setFocusedSlot(layout.focused)`
in an effect on the focused leaf and `forEachApi` loops. Clicking inside a pane body or strip focuses its leaf (`pointerdown` capture on the body wrapper, as the
slot focus does today).

### D11. Topbar → app menu in the rail

The desktop topbar (`App.tsx` l.2337-2378) is removed: the strips are in the panes, and `+` lives in each strip. The
app menu `IconButton` moves to the top of `DockPanel`'s rail in every display mode (first rail child,
`data-testid="app-menu-button"` kept, `DropdownMenu` `align="end"` `side="left"`, since the rail is at the window's
right edge; the kit's `DropdownMenuProps` gains `side?: 'top' | 'right' | 'bottom' | 'left'`, forwarded to Radix). `DockPanelProps` gains `menu?: { items: DropdownMenuItemSpec[] }`; App passes its existing
`appMenuItems`, and the button is the first child of `nav.dock-rail`. In window-controls-overlay mode a `.wco-titlebar` empty drag region (`-webkit-app-region: drag`, height
`env(titlebar-area-height)`, full width) stays above the content row so the native controls never cover the rail. The rail-alignment
test in `App.test.tsx` (`--rail-w`) is replaced by a test that the menu is the rail's first control.

### D12. Colour groups per pane

Membership and contiguity stay server rules. Each strip runs `buildStrip` over its own subset, so a group spanning
two panes draws a chip and frame in each. The collapse guard and the auto-expand effect live in
`session/useTabGroups.ts` (the guard l.153-176, the effect l.81-91) and read only `sessionId` today. They take two new
inputs, `activeIds: string[]` (every leaf's active tab) and `stripOf(tabId): string[]` (the full member list of the
leaf holding it, server order), plus a `switchTo(fromId, toId)` callback. For each active id that is a member, the
guard picks the nearest outside tab in that leaf's list; if any has none, it refuses with the existing toast;
otherwise it switches each of them, then collapses. Auto-expand keys on `activeIds`. With groups disabled App passes
`[sessionId]` and the full list, which is today's behaviour.

### D13. Mobile and pop-out

With the mobile layer or a pop-out, `useEditorGroups(false)` returns a virtual single-leaf layout holding every tab
with `active = sessionId` and never persists. `singleLeaf(tabs, active)` appends `{id: active, kind: 'terminal'}`
when `active` names no tab, because that is today's spawn-on-attach fallback (`App.tsx` l.529: an unknown id is a
terminal): a phone that creates a terminal selects an id the server has not broadcast, and only the pane's attach
creates it. The virtual leaf's id is the held layout's `focused` leaf id (else `p0`), so the pane keeps its key when
the layer flips; `GroupsView` then draws no strip (mobile has the drawer; the pop-out has
its own bar). Toggling the mobile layer off restores the window's saved layout and runs `show(sessionId)` against it,
except on the New-tab page: there App hands the hook no selection (`sessionId` is `''` while the page is up, though
App keeps the closed tab's id), so the flip back restores the saved layout reconciled against the list and shows
nothing, and the flip to the phone draws an empty pane, so the closed id is never drawn as a terminal. If the
restored focused leaf does not hold that tab, the tab moves panes the way any move does: the old pane switches to its
own active tab in place and the leaf holding it attaches. That is the cross-pane move path, guarded by `ws.ts`
`abandon()` (a replaced socket's late `detached` reaches no pane), and the e2e in 6.2 moves a terminal between panes
to prove no "Opened somewhere else" appears.

The drawer's "Split"-free long-press sheet and the mobile drawer are unchanged.

### Migration / compatibility / observability / cost

- No server, protocol or file format change; an older client keeps working against the same server.
- Old stores are ignored, not migrated (a discardable view preference, as `useSplit.ts` l.288 already says).
- No new network traffic; one xterm and one WebGL context per terminal PANE (not per tab).
- Observability: none new; the diagnostics report already lists tabs, and a test-only `data-pane-id` on each
  strip and body makes layouts inspectable in e2e.

## Risks / Trade-offs

- [A terminal remounts during a split or merge] → `TerminalPane` keyed by leaf id, leaf ids stable across every
  operation except `removeLeaf` of that leaf; the ported one-mount test covers a split, a merge and a move.
- [An iframe or Monaco reloads] → flat rendering only; a test asserts the `PaneHost` child node identity survives a
  split next to it.
- [Boot spawns shells for a stale saved layout] → no pane mounts until the first broadcast has reconciled the layout.
- [A relaunched PWA loses its panes] → accepted for v1 (no device copy, see D5); one pane on the last tab.
- [A narrow window with many panes] → the 15% clamp per branch bounds sash drags; a drop creating a pane below the
  pill minimum still works and the strip scrolls. Accepted: VS Code behaves the same.
- [Trade-off: a moved tab lands at its server-order position in the target strip, not at the end] → keeps one order;
  a strip drop places it exactly.
- [Trade-off: the topbar disappears] → the app menu moves to the rail; veto-able (proposal Impact).
