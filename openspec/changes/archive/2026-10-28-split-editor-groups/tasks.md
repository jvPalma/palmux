# Tasks

Paths are under `packages/client/src/` unless they start with `openspec/`, `CLAUDE.md` or `~`. Scoped tests:
`yarn workspace @palmux/client vitest run <files>`. A task is done only when `yarn typecheck` and its scoped tests
pass; every task below leaves the build green on its own. No server file changes. No git write commands.

## 1. Layout model (pure)

- [x] 1.1 Create `session/pane-grid.ts` with exactly the types of design D1: `Orientation`, `TabRef`, `PaneLeaf`,
  `PaneBranch`, `PaneNode`, `PaneLayout` (`v: 3`, `root`, `focused`, `nextId: number`), `Side`, plus
  `Rect = { left: number; top: number; width: number; height: number }` (percent) and `Sash = { path: number[];
  index: number; orientation: Orientation; rect: Rect; branch: Rect }`. Export `MIN_FRACTION = 0.15` and
  `rectCss(r: Rect, bodyOffset = false)` returning `{ left: \`${r.left}%\`, top, width, height }`; with `bodyOffset`
  true, `top` is `calc(<top>% + var(--group-strip-h))` and `height` `calc(<height>% - var(--group-strip-h))`. No React,
  no DOM.
- [x] 1.2 In `pane-grid.ts` implement `singleLeaf(tabs: TabRef[], active: string | null, leafId = 'p0'): PaneLayout`
  (`nextId: 1` or above the given id, `size: 1`, `focused: leafId`; when `active` names no tab it appends `{ id: active,
  kind: 'terminal' }` (`''` is treated as `null`), the spawn-on-attach fallback of design D13), `leaves(layout): PaneLeaf[]` (depth-first, left/top first) and
  `leafOf(layout, tabId): PaneLeaf | null`.
- [x] 1.3 Implement `removeTab(layout, tabId, order: string[])` and `removeLeaf(layout, leafId)` per D1. The new
  active is `neighborAfterClose(order filtered to the leaf, tabId, survivors)` from `session/tab-meta.ts`.
  `removeLeaf`: proportional size hand-off, single-child branch replaced by its child, a same-orientation child branch
  spliced into the grandparent with sizes multiplied, root promotion, never removes the last leaf, and changes
  `focused` only when `focused === leafId`. Head comment on `removeLeaf`: `// Sibling collapse ported from VS Code
  src/vs/base/browser/ui/grid/gridview.ts removeView. Copyright (c) Microsoft Corporation. Licensed under the MIT
  License.`
- [x] 1.4 Implement `splitPane(layout, targetLeafId, side, tab: TabRef, order)` per D1: `removeTab` first; same-
  orientation parent → sibling before (left/top) or after (right/bottom), halving the target's size; otherwise wrap
  the target in a `row` (left/right) or `column` (top/bottom) branch, children 0.5 / 0.5, the branch taking the
  target's size. New leaf id `p${nextId.toString(36)}`, `nextId + 1`, new leaf focused with `active = tab.id`. Return
  the layout unchanged when `tab` is the target leaf's only tab. Head comment: `// Side → sibling or wrap ported from
  VS Code src/vs/base/browser/ui/grid/grid.ts getRelativeLocation. Copyright (c) Microsoft Corporation. Licensed under
  the MIT License.`
- [x] 1.5 Implement `moveTab(layout, tabId, targetLeafId, order)` (own leaf → activate and focus only; else
  `removeTab` then append, active, focus target), `activate(layout, leafId, tabId)`, `focusLeaf(layout, leafId)` and
  `addTab(layout, leafId, tab, makeActive)`. All return the same object when nothing changes.
- [x] 1.6 Implement `resizeSash(layout, path, index, deltaFraction)` (siblings `index` and `index + 1` of the branch
  at `path`; each clamped ≥ `MIN_FRACTION`; sum preserved) and `layoutRects(layout) → { panes: Map<string, Rect>;
  sashes: Sash[] }` (percent of the content area; a sash `rect` is the zero-thickness boundary, `branch` its parent's
  rect).
- [x] 1.7 Implement `reconcile(layout, tabs: TabMeta[], prevOrder: string[], pending: ReadonlySet<string>)` exactly as
  design D6 steps 1–5 (step 2 falls back to the new order when `prevOrder` is empty; step 5 repairs EVERY leaf), returning
  the same object when nothing changed, and `parseLayout(raw: string | null): PaneLayout | null` with the D1 checks (`v === 3`, known
  node types, finite sizes > 0, each tab id in at most one leaf, `focused` names a leaf, each leaf's `active` is null or one of its tabs, every `kind` passes
  `isTabKind` from `@palmux/shared`, `nextId` an integer greater than `parseInt(id.slice(1), 36)` of every leaf).
- [x] 1.8 Create `session/pane-grid.test.ts`: the recording sequence (5 tabs → tab 2 right → a third column → a
  bottom drop in the right column; exact `layoutRects` percentages); same-orientation insert; cross-orientation wrap;
  lone-tab self split unchanged; every `removeLeaf` collapse case with sizes summing to 1; removing a non-focused leaf
  keeps focus; the last leaf stays; `moveTab` to its own leaf only activates; the neighbour rule uses `order`, not
  append order (leaf tabs appended `[6, 2]`, order `[2, 4, 6]`, closing 6 activates 2); `resizeSash` clamps at 0.15;
  `reconcile` (dead id, recycled kind, pending id kept, a pending id takes the kind a broadcast states, foreign tab into
  the focused leaf inactive, emptied leaf removed, a non-focused leaf whose active died at boot (empty `prevOrder`)
  takes its first tab, idempotent and the same reference when unchanged); `singleLeaf` with an unknown active appends a
  terminal; `parseLayout` rejects corrupt JSON, a duplicate id, a bad size, a stale `nextId` and an `active` outside its leaf.
  Scenarios: "Three columns with a row inside one", "First split from one pane", "A row inside a column", "Dragging a
  pane's only tab to its own edge does nothing", "Moving the last tab out", "Closing the last tab", "A recycled id",
  "Close the active tab".

## 2. Layout hook and registry

- [x] 2.0 `session/window-selection.ts`: replace the private `isKind` with `isTabKind` from `@palmux/shared` (it omits
  `'review'` today, so a window on a review always reloads onto the first tab), and export `resolveStoredSelection(tabs,
  stored): string | null` that answers the stored id only when it is live with the stored kind (no `tabs[0]` guess).
  `window-selection.test.ts`: a stored review resolves; a stale stored value answers `null` from the new helper.

- [x] 2.1 Create `session/useEditorGroups.ts`: `useEditorGroups({ enabled, tabs, ready, bootSelection, sessionId })`
  returning `{ layout, rects, sashes, focusedActive, hasSavedLayout(), show(ref: { id; kind; known }), commit(next), setLive(next),
  pending }`.
  `ready` false → `layout` null whether or not `enabled` (nothing mounts before the first broadcast on any path). First ready render: `parseLayout(sessionStorage['palmux-layout'])` ?? `singleLeaf(all
  tabs, bootSelection)`, then `reconcile` with an empty `pending`, then the D5 boot rule for `bootSelection`. Every
  later `tabs` change: `reconcile(layout, tabs, prevOrderRef.current, pending)`, then drop from `pending` every id the
  new list holds, then store the order in `prevOrderRef`. `show` per D5: a held id is activated and its leaf focused; otherwise `{ id, kind }` joins the focused leaf as active
  and enters `pending` only when `known` is false. `show` before ready is stored in `bootShowRef` and applied on the first
  ready render as the selection, after the `bootSelection` rule. `commit` persists in a try/catch; `setLive` sets state only. `enabled === false` → `layout` =
  `singleLeaf(all tabs, sessionId, heldFocusedId ?? 'p0')` recomputed each render, `show` is a no-op, no storage access.
  On `enabled` turning true the hook restores the saved layout and applies `show({ id: sessionId, … })` to it (D13).
  Each leaf's tab list for its strip is memoized per leaf (a `Map<leafId, TabMeta[]>` rebuilt only when that leaf or
  `tabs` changes) and exposed as `stripTabs(leafId)`.
- [x] 2.2 Create `session/useEditorGroups.test.ts` (`renderHook`): null before ready; restores a saved layout;
  discards a corrupt one; no `sessionStorage` access when disabled; a foreign tab joins the focused leaf inactive;
  a closed tab's leaf disappears; `show` of a new terminal id survives a broadcast that lacks it and stays after one
  that lists it; boot focuses the leaf holding `bootSelection`; a `null` `bootSelection` keeps the restored focus; a `show` before ready
  (the `?new=1` path) lands as the selection once ready; a `known` editor id never enters `pending`; disabled with an
  unknown `sessionId` yields a leaf holding it as a terminal (a phone creating a terminal); the mobile flip keeps the
  virtual leaf's id equal to the restored focused leaf's. A legacy id lands as the selection once ready (live: activated where it is, not
  pending; absent: a pending terminal); an unusable stored value with a saved layout keeps the restored focus; with
  `enabled` false and `ready` false the layout is `null`. Scenarios: "Reload restores", "A fresh window opens
  one pane", "A script asks for a terminal" (browser-local-tab-selection), "Two windows keep their own layouts", "A saved terminal that is gone", "Another window opens a tab", "A
  phone shows one pane", "A pop-out ignores the layout".
- [x] 2.3 `session/SplitFocusContext.ts`: `SlotId = string`; store `Map<string, PaneApi>`; initial focused slot
  `null`; add `forEachApi(fn: (api: PaneApi, slot: string) => void)`. Keep every existing export; `focusedSlot()` returns `string | null`. Widen `SplitViewProps.onFocusRequest` and App's
  `focusSlotHandler` parameter to `string` (guarding unknown values inside) so `SplitView` still typechecks until 5.1. In
  `App.tsx` replace the `'a'` / `'b'` literals at the four sites of design D10 with `forEachApi` (font refresh, theme
  refresh, `apiFor('a') ?? apiFor('b')` → the focused api, else the first). `terminal/TerminalPane.tsx`: `slot:
  string`. Extend the `SplitFocusContext` tests (add `session/SplitFocusContext.test.ts` if none exists) for
  `forEachApi` and a null initial focus.

## 3. Render components (built and tested, not yet wired)

- [x] 3.1 Create `session/Sash.tsx` from `SplitDivider.tsx`'s drag code: props `{ sash: Sash; containerRef:
  RefObject<HTMLElement>; onDrag(deltaFraction: number): void; onSettle(): void; onDragging(on: boolean): void }`;
  `deltaFraction` per design D9; 8px hit area (`.group-sash`, `cursor: col-resize | row-resize` by orientation),
  pointer capture, rAF throttle, no swap, no rotate, no transition; `onDrag` is cumulative from pointerdown, so the caller
  applies it to the layout captured at `onDragging(true)`; sets `data-sash-drag="true"` on the container on
  pointerdown and removes it on settle or cancel. `session/Sash.test.tsx`: deltas as branch fractions for a branch at
  50% width, one settle per drag, no settle on a stationary tap, attribute set and cleared.
- [x] 3.2 Create `session/GroupDropOverlay.tsx` per design D8: props `{ rect: Rect; canSplit: boolean; canCentre:
  boolean; onDropEdge(side: Side): void; onDropCentre(): void }`; reacts only to `TAB_DND_TYPE` (import it from
  `SessionTabs.tsx`); thirds rule horizontal first; `.group-drop-preview` half or whole; no transition.
  `session/GroupDropOverlay.test.tsx`: the five regions from `dragover` coordinates, the preview box per region, a
  `Files` drag shows nothing, `canSplit=false` suppresses edge preview and drop, `canCentre=false` the centre,
  `dragleave` clears. Scenarios: "Right edge preview", "File drags fall through".
- [x] 3.3 Create `session/GroupsView.tsx` per design D2. Props: `layout: PaneLayout | null` (renders nothing for `null`), `rects`, `sashes`, `tabs`, `strips:
  boolean`, `chooserPage: boolean`, `dragTabId: string | null`, `renderStrip(leaf: PaneLeaf, rect: Rect)`,
  `onFocusLeaf(leafId)`, `onDropEdge(leafId, side)`, `onDropCentre(leafId)`, `onSashDrag(sash, deltaFraction)`,
  `onSashSettle()`, `resizeBusy`, and every prop `SplitView` passes to `TerminalPane` and `PaneHost` today (copy the
  list from `SplitView.tsx`). One root `.groups-view` (`position: absolute; inset: 0`); every strip box, body, overlay, sash and the `PaneHost`
  are its direct children. `group-strip-focused` goes on the focused leaf's `.group-strip` box. Per leaf with a terminal active: `<ErrorBoundary key={leaf.id}
  label="Terminal" style={bodyCss}>` around `<TerminalPane key={leaf.id} slot={leaf.id} sessionId={tabId}
  resizePaused={sashDragging || resizeBusy} …>`. One `PaneHost` with `bodyOffset={strips}` and `rects[tabId]` = the pane rect for each leaf whose active tab is not a
  terminal. Overlay per leaf while `dragTabId`: `canCentre = !leaf.tabs.some((t) => t.id ===
  dragTabId)`, `canSplit = canCentre || leaf.tabs.length > 1`. One `Sash` per sash; on settle
  `requestAnimationFrame(() => registry.forEachApi((a) => a.refit()))`. Body offset `top: calc(<top>% +
  var(--group-strip-h))`, `height: calc(<height>% - var(--group-strip-h))`; `strips={false}` sets `--group-strip-h:
  0px` inline on the root and renders no strip; `chooserPage` renders the strip of the single leaf and no body.
  `data-pane-id` on each strip box and body. Pointerdown (capture) on a body or strip box calls `onFocusLeaf`.
- [x] 3.4 Create `session/GroupsView.test.tsx` from `SplitView.test.tsx`'s harness, mocking `WebPane` (not
  `PaneHost`) as `<div data-testid="web-node">`: a leaf's terminal mounts once across three `sessionId` changes; a
  split beside it, a merge and a move of another tab do not remount it; the `web-node` element is the same reference
  before and after a split beside it; every pane body and strip is a direct child of the view root; `strips={false}`
  renders no strip; `chooserPage` renders no body; only the focused leaf's `.group-strip` has `group-strip-focused`. Scenarios: "Switching tabs inside a pane", "Splitting next to an
  iframe".

## 4. Integration (depends on 1–3)

- [x] 4.1 Wire editor groups into the strip, the controller and App as ONE task (each step alone breaks the build):
  a. `session/tab-groups.ts`: delete `planFusions`, the `fused` `StripItem` variant and `buildStrip`'s `pairings`
     parameter. `tab-groups.test.ts`: delete the fusion cases; add a group spanning two subset lists drawing a chip in
     each.
  b. `session/SessionTabs.tsx`: delete the `pairings` prop, the fused branch (l.569-686), `focusedByA` and ghost-
     partner placement; keep "Split right" / "Split down" for every tab on desktop; add `paneId: string` and `onDropFromOtherPane(id: string)`; a strip drop of an id not
     in `tabs` calls `onDropFromOtherPane` and never `onReorder`. `SessionTabs.test.tsx`: delete fused tests; add the
     cross-pane drop.
  c. `session/workspaceController.ts`: `WorkspaceCtx` drops `pairings` and `groupOf` and gains `groups: boolean` and
     `leafOf(tabId): { id: string; count: number } | null`. Events: `selectTab`, `menuSplit { tabId; side: 'right' |
     'bottom' }`, `tabCreated { id }`, `sessionsBroadcast`. Effects: `navigate`, `chooserPage`, `split { leafId;
     tabId; side }`, `splitLone { leafId; side }`. `menuSplit` → `splitLone` when `count === 1`, else `split`;
     `sessionsBroadcast` with `groups` → only `chooserPage` when the new list is empty; without `groups` → today's
     neighbour logic minus the pairing guard. Imports from `useSplit` go. `workspaceController.test.ts`: delete
     every `focusSlot`, old `menuSplit`, `dropSplit`, `dropSlot`, `eject`, pairing `tabCreated` and pairing
     `sessionsBroadcast` case; add `menuSplit` → `split` / `splitLone` and the groups-mode `sessionsBroadcast`.
  d. `App.tsx`: add `const [sessionsReady, setSessionsReady] = useState(false)`, set true in the `sessions` branch
     after `setTabs(msg.tabs)`. Replace `useSplit` with `useEditorGroups({ enabled: !mobileActive && !popout, tabs,
     ready: sessionsReady, bootSelection, sessionId })`; rename the state setter to `setSessionIdRaw` and add the D5
     choke point `setSessionId` (kind and `known` from `tabsRef.current`) plus the `[enabled, focusedActive]` effect,
     which writes `sessionIdRef.current` first and skips `null`. `bootSelection` = `resolveStoredSelection(...)` from the
     `awaitingResolve` branch only, else `null`. With groups enabled that branch calls `showTab` only when the
     stored selection resolves or no saved layout exists, and keeps `setChooserPage(true)` for an empty list (design D5).
     In the boot effect (l.735-741), a `legacy` boot calls `setSessionId(boot.id)`, read through a ref
     (`setSessionIdRef.current`) so the effect's `[popout]` deps stay lint-clean. "No saved layout" is read from the hook's
     `hasSavedLayout()` (`parseLayout(sessionStorage['palmux-layout']) !== null`); App never reads the key itself. Render `GroupsView` where `SplitView` is
     (l.2385) with `renderStrip` = `SessionTabs` for the leaf (`current` =
     `leaf.active`, `onSwitch` → `selectTab`, `onNewTab` → `commit(focusLeaf(layout, leaf.id))` then the existing new-
     tab path, `tabs` = `groups.stripTabs(leaf.id)`, `onReorder` → `doReorder(leafTabIds, …)` per design D3, `onMoveGroup` →
     `moveGroup(leafTabIds, gid, index, anchor)` mapped the same way, `onDropFromOtherPane` →
     `commit(moveTab(layout, id, leaf.id, order))`, `onSplit` → `dispatch({ type: 'menuSplit', … })`). `onDropEdge`
     → `commit(splitPane(…))`, `onDropCentre` → `commit(moveTab(…))`. `applyEffect`: `split` → `commit(splitPane(…))`;
     `splitLone` per design D7. TerminalPane's `onFocusRequest(slot)` → `commit(focusLeaf(layout, slot))`; `onPaneFocus(id)`
     (l.2261-2269) → focus `leafOf(layout, id)`; delete `focusSlotHandler` (l.1223-1226) and its `focusSlot` dispatch, and
     the `useSplit` imports (l.104-111). Sash drags: capture the layout at `onDragging(true)` and `setLive(resizeSash(
     captured, …))`. `createTab` (terminal): exclude every id in `tabs` and in `layout`. In the
     `tabCreated` branch keep `pendingReviewsRef.current.delete(answered.url)` and send `{ type: 'tabCreated', id }`.
     Delete: `visibleEntries`' pairing argument, `stripPairings`, the boot-focus effect (l.789-796), fuse apply, the
     pairing reconcile effect and `pendingFreshRef`, `doSplit` / `doCollapse` / `doDropSlot`, `showEdgeZones` /
     `showSlotZones`, the pairing exclusion in `createTab`, the pairing block reorder, the boot single-id guard's comment
     (l.2389-2393) while KEEPING `chooserPage={chooserPage || !sessionId}` on `GroupsView` (l.2394), and the `openSplit` / `dissolveP` / `setSlot` / `focusSlotP` / `fuseSync` / `unsee` effect cases.
  d2. Batch-B/A inspection carry-overs (do these in 4.1): `GroupsView` gets `bodyOffset={strips}` on `PaneHost` (with
     4.5); App captures the sash start layout on `onSashDragging(true)` and clears it on `false` (the only signal on
     every end path: release, cancel, unmount), on `onSashSettle` committing the hook's CURRENT layout (state or a ref), never a layout App held from `setLive`
     (`onSashSettle` also fires from a sash's unmount path, after a broadcast reshaped the layout); `menuSplit` and other
     layout commands are refused while a sash drag is on (the next drag frame would undo them); per-leaf props
     passed to `SessionTabs` through `renderStrip` must be memo-stable (per-leaf callbacks cached by leaf id) so a sash
     frame does not re-render every strip; `onFocusRequest`/`onPaneFocus` both map to `focusLeaf`. The CSS that
     `GroupsView` needs ships WITH 4.1, not in 5.2: `.content-area { --group-strip-h: … }`, `.group-strip` (absolute, its
     height, background, `border-bottom`; NO z-index, its `.tab-menu` must escape to the outer stacking context),
     `.group-strip.group-strip-focused`, `.group-drop-overlay { z-index: 40 }`, `.group-drop-preview`, `.group-sash`,
     `.content-area[data-sash-drag='true'] iframe { pointer-events: none }`, `.newtab-page { top: var(--group-strip-h) }`.
     `onSashSettle` runs right after the final `onSashDrag`, so App reads the hook's layout from a REF there, not
     state. A broadcast that reshapes the layout mid-drag ends the drag's capture: App re-captures the start layout
     from the reconciled layout (or ignores further frames until the next pointerdown), so a frame can never re-apply
     `resizeSash(startLayout, …)` over a reshaped layout. Sash: call `e.preventDefault()` BEFORE the button guard (a
     non-primary press on a handle must not move focus off the terminal); flip `Sash.test.tsx`'s refused-press case to
     expect `defaultPrevented`, and end it with a primary press that drags and settles exactly once.
     Clear `chooserPage` whenever `focusedActive` turns non-null (a blank window can leave the New-tab page through a
     `commit` alone, e.g. dragging a foreign tab to a pane edge). Call `commit`/`setLive` only from handlers or
     `useEffect`s, never from a `useLayoutEffect` (the hook's `agreedRef`/pending writes are post-commit passive effects).
     Move `.groups-view`'s inline `position: absolute; inset: 0` into the stylesheet. Delete the body ring
     `.term-wrap.slot.focused` (focus is marked through the strip only, per the spec).
  e. `App.test.tsx`: delete `describe('split display scoping …')`, `'drag-onto-slot replacement'`, `'per-slot
     eject'`, `'reconcile with the pairing (review fixes)'`, `'a fused pill inside the group'` and every other test
     using `openSplitVia`, `palmux-splits` or `slot-eject`; replace `term-pane-a` with `term-pane-p0`; add: an edge
     drop makes two panes; the `+` of pane B creates in B; reopening an open file focuses its pane; closing pane A's
     active tab activates its left neighbour and leaves B unchanged.
  Scenarios: "Two strips", "Plus creates in its own pane", "Strip drop keeps the server order", "A pane's reorder
  maps to the full order", "Centre drop", "Opening a file", "Reopening an open file", "Clicking a pane moves input",
  "Focus is the window selection", "A group spanning two panes".
- [x] 4.2 `keybindings/keybindings.ts`: delete `toggleSplitOrientation` from the action union, `ACTIONS`, labels and
  `DEFAULT_BINDINGS`; `splitRight` / `splitDown` have no handler today (`actionHandlers` in App l.1709-1738 lacks them): add one that
  dispatches `menuSplit` for the focused leaf's active tab. This is new behaviour and the first test of these chords. `keybindings.test.ts`: a persisted `toggleSplitOrientation` binding is ignored. `App.test.tsx`:
  Ctrl+Shift+D moves the active tab right; on a lone tab it adds a terminal pane. Scenarios: "Split right moves the
  tab", "Split on a lone tab opens a terminal".
- [x] 4.3 Collapse guard per pane (design D12) in `session/useTabGroups.ts` (guard l.153-176, auto-expand l.81-91): new
  inputs `activeIds: string[]`, `stripOf(tabId): string[]` and `switchTo(fromId, toId)`; App passes every leaf's active,
  the leaf's full list and a `switchTo` that commits `activate` on that leaf (groups disabled: `[sessionId]`, the full
  list, `selectTab`). `useTabGroups.test.ts`: refused when one affected pane has no outside tab; otherwise each affected
  pane switches; auto-expand fires for a non-focused leaf's active member. Scenarios: "Collapse protects every pane", "Active tab is protected".
- [x] 4.4 Topbar removal and rail menu (design D11): `session/DockPanel.tsx` gains `menu?: { items:
  DropdownMenuItemSpec[] }`, rendered as the first child of `nav.dock-rail` (`IconButton`
  `data-testid="app-menu-button"`, `aria-label="palmux menu"`, `DropdownMenu align="end" side="left"`). `ui/DropdownMenu.tsx`: add `side?: 'top' | 'right' | 'bottom' | 'left'`
  forwarded to Radix `Content`, with a case in `ui/DropdownMenu.test.tsx`. `App.tsx`:
  delete the `.topbar` element (l.2337-2378), pass `menu={{ items: appMenuItems }}`, and render `<div
  className="wco-titlebar" />` before `.content-row` (CSS shows it only in WCO). `DockPanel.test.tsx`: rail order
  `['app-menu-button', 'dock-rail-newtab', …]`. `App.test.tsx`: no `.topbar`, the menu opens Settings, the `--rail-w`
  alignment test deleted. Scenarios: "The menu tops the rail", "Window-controls-overlay keeps a title bar", "A second
  route to Settings", "Settings sits at the bottom".
- [x] 4.5 `panes/PaneHost.tsx`: import `Rect` and `rectCss` from `session/pane-grid.ts`, delete its local copy and take
  `bodyOffset: boolean` (false for mobile and pop-out), passed to `rectCss`;
  `inSplit` becomes "more than one leaf". `review/review-host.ts`: the comment names `GroupsView`.

## 5. Removal, CSS, docs (depends on 4)

- [x] 5.1 Delete `session/useSplit.ts`, `useSplit.test.ts`, `SplitView.tsx`, `SplitView.test.tsx`,
  `SplitDivider.tsx`, `SplitDivider.test.tsx`, `SplitDropZones.tsx`, `SplitDropZones.test.tsx`, `SlotDropZones.tsx`,
  `SlotDropZones.test.tsx`. `grep -rE "useSplit|SplitView|SplitDivider|SplitDropZones|SlotDropZones|pairings"
  packages/client/src` finds nothing.
- [x] 5.2 `index.css`: ALSO declare `--cluster-pad: 2px` on `:root` (keep it on `.session-tabs, .drawer-sessions, .drawer-top`,
  which `SessionDrawer.test.tsx` l.352/426 pins); add `.content-area { --group-strip-h: calc(var(--ctl-h)
  + 2 * (var(--cluster-pad) + 1px)) }`, `.group-strip` (absolute, `height: var(--group-strip-h)`, `background:
  var(--t-mantle)`, `border-bottom: 1px solid var(--t-surface)`), `.group-strip.group-strip-focused { border-bottom-color:
  var(--t-accent) }`, `.newtab-page { top: var(--group-strip-h) }` so the single leaf's strip stays visible over the chooser page,
  `.group-drop-overlay { z-index: 40 }` (the old `.split-dropzones` value, above `.pane-host` 20 and `.newtab-page` 25, so a
  drag over an iframe or editor still reaches it), `.group-sash` (sizes from the scale, e.g. `var(--sp-2)`, never a literal `8px`), `.group-drop-preview` (the `.split-drop-preview` colour mix),
  `.content-area[data-sash-drag='true'] iframe { pointer-events: none }`, `.wco-titlebar { display: none }` and,
  inside the WCO media block, `.wco-titlebar { display: block; height: env(titlebar-area-height); -webkit-app-region:
  drag }`. Delete `.topbar*` (l.2141-2190 and the WCO `.topbar` rules l.2964-2990), `.split-divider*`, the rotate
  handle, `.slot-eject*`, the old drop-zone rules, `.ctab.fused*`, `.fused-seg*` and `.fused-glyph`. Must pass
  `ui/scale.test.ts` and `ui/ui.test.tsx`.
- [x] 5.3 `session/tab-strip-css.test.ts`: replace every `bodyOf('.topbar')` (l.47, l.106-108, l.170-175, l.214, including "centres the strip and the topbar on
  one line" and "ends the topbar in a 1px separator") with `.group-strip`; delete "fills on hover only a fused segment that is not the
  focused one", "draws the split glyph and the seam…", "rings an active pairing…", "keeps a minimum width on each
  fused segment" and `describe('split divider rotate handle')`; rewrite `describe('window-controls-overlay')` to
  assert `.wco-titlebar` has `height: env(titlebar-area-height)` and `-webkit-app-region: drag` and that no `.topbar`
  rule remains; make the `--cluster-pad` token check (l.226) also accept `:root`. Add a case that the `group-strip-focused` rule's selector
  includes `.group-strip`, the selector that declares `border-bottom`.
- [x] 5.4 `tips/tips.ts`: delete "Split: swap and rotate"; rename "Split view (desktop)" to "Panes (desktop)" with
  this body: "Drag a tab to the edge of a pane to open a new pane there, or onto a pane's middle or its tabs to move
  it. Right-click a tab → Split right / Split down, or Ctrl+Shift+D / Ctrl+Shift+E. Each pane has its own tabs and
  +, closes with its last tab, and drags its sashes to resize. Remembered per window; desktop-only."; remove the
  fused-pair sentence from the reorder tip and "a split, " from the collapse tip. Update `tips.test.ts` if it pins
  titles.
- [x] 5.5 `CLAUDE.md`: rewrite "Split view (desktop-only) + de-singletonized terminal" (keep the control socket,
  last-attach-wins, pop-out and input-hygiene parts); delete "Split fusion", "Split gestures live on the divider",
  "Dragging the active tab onto its own pane is refused" and the fused-pill strip paragraph; replace the topbar and
  app-menu paragraph with the rail menu; "keyed by SLOT" → "keyed by PANE". Add "Editor groups": `pane-grid.ts` and
  its two ported VS Code functions, flat rendering, one order,  the layout as selection source of truth, `pending`,
  per-window persistence and why there is no device copy, boot gating, drop regions, one tab in one pane.
  Also record the accepted limit: a sash-drag frame adopted after a cross-window close of a pane's active tab
  re-picks that pane's first surviving tab, not the left neighbour (rare; `adopt` has no previous order).
  Also record, in CLAUDE.md's window-selection paragraph, the mid-session rule with groups: a selected tab whose id
  comes back as another kind leaves its pane and the pane shows its neighbour (the flat mobile path keeps the old
  behaviour).

## 6. Verification and deploy (depends on 5)

- [x] 6.1 Gates: `yarn typecheck`, `yarn lint`, `yarn workspace @palmux/client vitest run`, `yarn workspace
  @palmux/server vitest run`, `openspec validate split-editor-groups --strict`. Record the counts.
  Recorded after batch D1: typecheck clean (shared, client, server); lint 0 errors (1022 warnings); client
  140 files / 4589 tests; server 48 files / 863 tests; `openspec validate --strict` valid.
- [x] 6.2 Browser e2e against an isolated server, never :44040. `~/.cache/claudex-nomcp/scr-smoke.sh build` builds
  the client into `/tmp/palmux-scr-smoke/dist`; `… start` runs the server on 127.0.0.1:44099 with auth off and its
  config, HOME and tmux socket under `/tmp/palmux-scr-smoke`; `… stop` ends it. If the script is missing, build with
  `npx vite build --outDir /tmp/palmux-scr-smoke/dist` and start the server with `PALMUX_NO_AUTH=1` on port 44099 and
  a config dir under `/tmp`. Chromium 1440×900: the recording sequence (5 terminals → right drop → third column →
  bottom drop in a column → sash resize → last tab moved out → pane gone); a web tab beside a split keeps a
  `window.name` marker (no reload); reload restores the layout; a second window opens one pane; no "Opened somewhere
  else" overlay at any point; 390×844 touch emulation shows one pane and the drawer. Screenshots go to
  `~/.agent/diagrams/palmux-split-shots/`.
- [x] 6.3 Build the production client (`yarn workspace @palmux/client build`). The owner's standing approval covers
  this client build after an inspected batch; no server restart is needed, and none may happen without asking.
  Confirm the hash in `packages/client/dist/index.html` matches what `https://palmux.dgsl.pt/` serves.
