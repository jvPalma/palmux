# Tasks

Paths are under `packages/` unless they start with `openspec/` or `CLAUDE.md`. Scoped tests:
`yarn workspace @palmux/<pkg> vitest run <files>`. A task is done only when `yarn typecheck` and its scoped tests
pass, and every phase leaves the build green. New parameters are OPTIONAL with main-window defaults, and old
exports stay until the task that deletes them. No git write commands. Never start, stop or restart the production
server on :44040. Use the isolated smoke server (`~/.cache/claudex-nomcp/scr-smoke.sh`) for e2e. Prerequisite:
`split-editor-groups` is archived (the owner's call) before 6.2 runs.

## 1. Shared protocol

- [x] 1.1 In `shared/src/protocol.ts`:
  - Add `export function isWindowId(s: unknown): s is string` (`typeof s === 'string' && /^w[0-9a-z]{6,16}$/.test(s)`).
  - Add `window?: string` to `TabMeta`, with the doc comment "Detached window holding this tab (isWindowId);
    absent = the main window."
  - Add `detachedWindows?: true` to `ReadyMessage`.
  - Add `window?: string` to `CreateTabMessage`.
  - Add `MoveToWindowMessage { type: 'moveToWindow'; ids: string[]; window: string | null }` and
    `WindowClosingMessage { type: 'windowClosing' }` to `ClientMessage`.

  Parsing:
  - `parseTabMeta` copies `window` only when `isWindowId`.
  - `parseClientMessage`:
    - `moveToWindow` requires `Array.isArray(ids) && ids.length <= 1000 && ids.every(isTabId)` (the existing id-list
      rule), and `window === null || isWindowId(window)`, else null;
    - `windowClosing` needs no fields;
    - `createTab.window` is kept only when `isWindowId`.
  - `parseServerMessage` keeps `ready.detachedWindows` only when it is `true`.

  Tests in `server/src/protocol.test.ts`:
  - valid and invalid window ids;
  - a non-tab id or 1001 ids rejected;
  - a bad `window` dropped from `TabMeta` and from `createTab`;
  - `ready.detachedWindows` parsing.

## 2. Server: ownership, lease, claims

- [x] 2.1 Registry in `server/src/server.ts` (depends on 1.1):
  - Add `window?: string` to `TabRecord` and emit it from `tabs()` (`:691`). Do NOT add it to `persist` (`:439`) or
    `PersistedTab`.
  - Add `setWindow(ids: string[], window: string | null): boolean` (set, or delete for null, on each known id;
    returns whether anything changed; no persist) and `tabsOfWindow(wid: string): string[]` to the registry
    interface (`:248-286`) and implementation.
  - `CreateTabSpec` (`:226`) gains `window?: string`. `createTab` sets it on the new record before
    `listChanged()`.
  - `get(id, spawn?: { command?: string; window?: string })` sets `rec.window = spawn.window` ONLY in the new-id
    branch (`:643`, before `listChanged()` at `:648`). It never does so in the live branch or the dormant
    `spawnInto` branch.

  Tests in `server/src/tabs-registry.test.ts`:
  - `tabs()` carries `window`;
  - `tabs.json` written after `setWindow` has no `window` key;
  - `get` with `window` on a new id sets it;
  - `get` on a live id leaves it unset;
  - `get` on a dormant restored record leaves it unset;
  - `createTab` with `window` sets it.

  (Spec: "A tab created in a detached window is born there", "Ownership is in memory".)
- [x] 2.2 Socket wiring in `server.ts` (depends on 2.1):
  - **`createServer` options.** `createServer` gains a 4th parameter,
    `opts: { windowGraceMs?: number; windowCloseGraceMs?: number } = {}`, defaulting to the exported
    `WINDOW_GRACE_MS = 15_000` and `WINDOW_CLOSE_GRACE_MS = 3_000`. It is passed to `attachWebSocket`.
  - **State, inside the `attachWebSocket` closure:** `windowSockets: Map<string, Set<WebSocket>>` and
    `graceTimers: Map<string, NodeJS.Timeout>`.
  - **`armGrace(wid, ms)`** clears any timer for `wid` and sets an `unref()`ed `setTimeout`. When it fires it runs
    `registry.setWindow(registry.tabsOfWindow(wid), null)`, `broadcastSessions()` and
    `console.info(\`palmux: window ${wid} released ${n} tabs (${reason})\`)` (the server's existing log style).
  - **`ConnectionDeps`** (`:1852`) gains
    `windows: { moved(window: string | null): void; closing(ws: WebSocket): void }`. `handleConnection` gains a
    `window: string | undefined` parameter, parsed in the upgrade handler from `params.get('window')` through
    `isWindowId`.
  - **Control socket with `window`:** on connect, add it to the set and clear `graceTimers[wid]`. On close, remove
    it. If the set is then empty and `tabsOfWindow(wid).length > 0`, call
    `armGrace(wid, closingSockets.has(ws) ? closeMs : graceMs)`, where `closingSockets` is a `WeakSet` that
    `windows.closing(ws)` adds to.
  - **Data socket with `window`:** pass `window` into `registry.get(id, { command, window })` beside the tmux
    command.
  - **Message cases in the switch at `:1964`:**
    - `moveToWindow`: `if (registry.setWindow(ids, window)) broadcastSessions()`, then
      `deps.windows.moved(window)`. `moved` arms `graceMs` when `window` is non-null, has no socket and has tabs.
    - `windowClosing`: `deps.windows.closing(ws)`. Any later message from that socket other than `ping`
      removes it from `closingSockets` (a cancelled unload), so a later real blip gets the full grace. A heartbeat
      `ping` never un-marks it.
    - `createTab`: pass `window` through.
  - **Map hygiene:** a fired timer deletes its `graceTimers` entry, and an emptied socket set deletes its
    `windowSockets` entry.
  - **`ready`:** add `detachedWindows: true` to the send.

  Tests in `server/src/ws-tabs.test.ts`, with real sockets and `createServer(cfg, secret, registry,
  { windowGraceMs: 80, windowCloseGraceMs: 20 })`:
  - `moveToWindow` broadcasts the field;
  - closing the window's control socket releases after the grace;
  - `windowClosing` then close releases after the short grace;
  - a reconnect inside the grace keeps the tabs;
  - a move to an unconnected id releases after the grace;
  - an invalid `window` param is ignored;
  - a message after `windowClosing` restores the full grace, and a `ping` does not;
  - `ready.detachedWindows === true`;
  - a data attach with `window` on a new id is listed with `window` in the FIRST broadcast that lists it.

  (Spec: "Ownership lives while the window lives", "Detached windows need a server", "A new terminal never flashes
  in main".)

## 3. Client plumbing (every change optional; App is untouched until phase 4)

- [x] 3.1 `client/src/session/session-url.ts` (depends on 1.1):
  - **New helpers:** `newWindowId()` (`'w'` plus 10 base-36 chars from `crypto.getRandomValues`), `windowPath(wid)`,
    and `windowIdFromPath(pathname)` (`/^\/window\/([^/]+)\/?$/`, then `isWindowId`).
  - **`BootIntent`** gains `{ kind: 'detached'; wid: string; tab: string | null; legacy: boolean }`:
    - `/window/<wid>` gives `tab` from `?tab=` when it passes `isTabId` (else null) and `legacy: false`;
    - `/window/<bad>` falls through to the app intent.
  - **Kept for now:** the `popout` kind, `openPopout`, `POPOUT_RETURN` and `postReturnToMain` stay; 4.4 deletes them.
  - **`openDetached(id): { wid: string; win: Window | null }`** opens `/window/<wid>?tab=<id>`, named
    `palmux-<wid>`, with the existing features.
  - **`wsControlUrl(window?: string)`** appends `&window=<wid>`.
  - **`wsUrlFor(id, kind?, clientKey?, tmux?, window?: string)`** appends `&window=<wid>`.

  Tests in `session-url.test.ts`.
- [x] 3.2 Client socket and layout hook:
  - **`client/src/lib/ws.ts`:**
    - `sendCreateTab`'s spec gains `window?: string`;
    - add `sendMoveToWindow(ids: string[], window: string | null)` and `sendWindowClosing()`.
  - **`client/src/session/useEditorGroups.ts`** gains the option `storageKey?: string` (default `LAYOUT_STORE_KEY`,
    used for every read and write). `order` stays the visible list's ids: panes hold visible ids only, and the
    visible order is a subsequence of the full one.
  - **`place(p: { id: string; leafId: string; where: 'centre' | Side })`:**
    - It stores `p` in hook STATE (`placements`).
    - In `derive`'s `held.active` branch, after `reconcile`, each placement whose `leafOf(next, p.id)` is
      non-null is applied, with the `TabRef` taken from that leaf:
      - `'centre'`: `activate(moveTab(next, p.id, target, order), target, p.id)`;
      - a side: `splitPane(next, target, p.where, ref, order)`.
    - `target` is `p.leafId` when it is still a leaf, else `next.focused`.
    - An applied placement is removed in the post-commit effect. Both operations already set focus.
  - **`heldTabIds(): string[]`** returns every tab id in the held layout, else in the saved one.

  Tests in `useEditorGroups.test.ts`: the key option, both `place` forms, the gone-leaf fallback, and a placement
  applied once only.

  **`client/src/session/useTabGroups.ts`** gains the option `fullTabsRef?: { current: TabMeta[] }` (default: its
  `tabsRef`). `addToGroup` builds `groupUpdate.order` from it, inserting after the group's last member in the FULL
  order. Collapse, switch, `groupCloseAll` and `removeFromGroup` keep `tabsRef`. Test: Add to group in a window with
  hidden tabs sends an order that keeps the hidden tabs in place.
- [x] 3.3 `client/src/session/window-selection.ts`:
  - `readSelection(window: string | null = null)` and `writeSelection(sel, window: string | null = null)` use
    `` `palmux-window-tab:${wid}` `` for a detached window, never touch `palmux-window-tab` there, and never fall
    back to `palmux-last-tab`.
  - `readLastTab` and `writeLastTab` are unchanged, and App never calls them in a detached window (4.1).

  Tests in `window-selection.test.ts`. (Spec: "A detached window keeps its own layout".)

## 4. App wiring (depends on 2, 3)

- [x] 4.1 Identity, boot and lists in `client/src/App.tsx`:
  - **Identity.**
    - `const detached = boot.kind === 'detached'`; `myWindow = detached ? boot.wid : null`.
    - The old `popout` boot kind is no longer produced, and `popout` reads become `detached` where D9 says.
    - `mobileActive` is forced false when `detached`, and `groupsEnabled = !mobileActive`.
  - **Boot, per design D13:**
    - `awaitingResolve` starts true and `sessionId` starts `''`.
    - In the `sessions` handler, in D13's order: write the refs, run the reclaim (4.3), then resolve from
      `visibleTabsRef.current` (`boot.tab`, then `readSelection(myWindow)`, then `resolveSelection`), then
      `showTab`. The existing `hasSavedLayout()` branch (`:1692-1695`) stays.
    - The boot-spent effect replaces the address with `windowPath(wid)` when `detached`.
    - The persist effect passes `myWindow` to `writeSelection` and never calls `writeLastTab` when `detached`.
  - **Lists, per design D5:**
    - Add `visibleOf(list, overrides)` and derive `visibleTabs = useMemo(() => visibleOf(tabs, optimisticWindow),
      [tabs, optimisticWindow])`. Return `tabs` itself when nothing is filtered out or overridden.
    - Add `visibleTabsRef`. Write it beside every `tabsRef` write (`:1456`, `:1495`, `:1544`, `:1562`, `:1680`,
      `:1686`, `:1718`), always as `visibleOf(tabsRef.current, optimisticRef.current)`.
    - The `pending` and `seenTermIds` loops (`:1651-1662`) keep iterating the FULL `msg.tabs`.
    - `activeTab` (`:530`) reads `visibleTabs`.
    - Feed the first-column readers of D5's table, including `GroupsView`'s `tabs` and `leaveReview`. Dispatch
      `sessionsBroadcast` with the filtered list. Pass
      `useEditorGroups` `{ tabs: visibleTabs, storageKey: layoutKey(myWindow) }`. App's `tabOrder()` stays the
      full order for `splitPane`/`moveTab`/`removeTab`. Pass
      `useTabGroups` the visible list and ref, plus `fullTabsRef: tabsRef`.
    - **The guard of D15:** `setSessionId` and the controller's `tabCreated` navigate ignore an id in `tabsRef`
      but not in `visibleTabsRef`.
    - **The optimistic map of D7** is React state, with one 2 s timer per entry, mirrored by `optimisticRef`.
      Every writer (`moveTabsToWindow`, the dragend path, the handler's confirm removal, the expiry timer) writes
      the ref first, then the state. The `sessions` handler removes a confirmed entry synchronously from the ref, from the state (functional update)
      and clears its timer. Point the dragged-tab safety net (`:1720-1730`) at the visible
      list.
  - **Sockets.** The control `WsClient` uses `wsControlUrl(myWindow ?? undefined)`. App → `GroupsView`
    (`window: string | null`) → `TerminalPane` (`window`) → `wsUrlFor(..., window ?? undefined)`.
  - **Capability.** `capDetached` state is set from `ready.detachedWindows`.

  Tests in `App.test.tsx`:
  - a main window hides a tab with `window`;
  - a detached window shows only its own;
  - the reorder sends the full order with hidden tabs in place;
  - "Close other tabs" and a group's Close all spare the other window's tabs;
  - `freshTerminalId` skips a hidden id;
  - a detached boot removes `?tab=` and lands on that tab;
  - `palmux-last-tab` is never written by a detached window;
  - an in-flight broadcast does not flash a moved tab back, and a refused move reappears after 2 s;
  - main mounts no hidden pane for an editor a detached window holds;
  - a navigation to another window's tab id does nothing (no pane, no socket);
  - Add to group keeps hidden tabs in place in the order sent.

  Also in `App.test.tsx`: a terminal pane's data URL carries `window` (there is no `TerminalPane.test.tsx`).
- [x] 4.2 Opening and moving:
  - **`moveTabsToWindow(ids, window)`**, when `window !== myWindow`, first confirms per D7 when any of the ids is a
    dirty editor, and moves nothing on Cancel. A move into this window (a reclaim, a drop here) never confirms.
    It then deletes the moved ids from `dirtyTabs`, writes the optimistic map and both refs, calls `setTabs`, and
    sends. It returns `true` when it sent, `false` when it refused or the user cancelled; a caller calls
    `groups.place` only on `true`, so a refused move never parks a placement.
    - It refuses an id that is not in `tabsRef` (a pending terminal) with the toast "Wait for the terminal to
      start".
    - A dirty editor pill's `dragstart` also sets `TAB_DIRTY_DND_TYPE = 'application/x-palmux-dirty'`, exported
      beside `TAB_DND_TYPE` (`SessionTabs.tsx:37`), from a new `isDirty(id)` prop.
  - **`doPopout(id)`, per design D7,** uses `openDetached`. A null `win` shows the existing toast and moves
    nothing. Strips get `onPopout` only when `capDetached && !mobileActive`.
  - **Strip menu.**
    - It gets `onMoveToMain` (detached only), which calls `moveTabsToWindow([id], null)`.
    - In `client/src/session/SessionTabs.tsx`, add the item `menu-move-main` ("Move to main window", icon
      `external`) in the LAYOUT group, before "Open in new window".
  - **`createTab`** for a non-terminal sends `window: myWindow ?? undefined`.
  - **`openReview`, per design D14:** a match in the FULL list held by another window is moved here and shown. No
    `createTab` is sent.
  - **`openFileTab`, per design D14:** a path held by another window shows the toast "`<name>` is open in another
    window" and sends nothing.

  Tests:
  - the move scenarios;
  - the blocked-popup toast;
  - the item hidden without `capDetached` and on mobile;
  - the menu item only in a detached window;
  - a review held by main is moved, not duplicated;
  - moving a dirty editor asks first, and Cancel moves nothing;
  - a reclaim of a dirty editor never asks;
  - a file held by another window toasts and sends nothing;
  - a confirmed move clears the moved ids from `dirtyTabs`;
  - a pending terminal cannot be opened in a new window.

  (Spec: "Open in new window moves the tab", "Move to main window returns a tab", "Detached windows need a
  server".)
- [x] 4.3 Reclaim, legacy and self-close (detached only):
  - **Reclaim.**
    - `firstOpenRef` is true until the first control open has been handled.
    - On the first `sessions` after each control open (an `awaitingReclaimRef` set in the ws `onOpen`), compute
      `ids = heldTabIds()`, plus `boot.tab` only while `firstOpenRef`.
    - Filter `ids` to tabs listed with no `window`.
    - If any remain, call `moveTabsToWindow(ids, myWindow)` and `setReclaiming(new Set(ids))`. The next broadcast
      calls `setReclaiming(new Set())`.
  - **Legacy boot.** `boot.legacy` boots exactly like a normal detached boot. Its `tab` goes through the reclaim.
  - **Self-close.**
    - An effect on `[visibleTabs, reclaiming, capDetached]`. `pendingTabs` is read inside it but is not a
      dependency: it is the hook's mutable `Set`, and every pending id leaves on a broadcast that also changes
      `visibleTabs`.
    - `seenOwnRef` becomes true once `visibleTabs.length > 0`.
    - When `seenOwnRef && capDetached && visibleTabs.length === 0 && pendingTabs.size === 0 && reclaiming.size === 0`:
      call `sendWindowClosing()`, then `window.close()`. One `setTimeout(0)` later, if `!window.closed`, set the
      New-tab page.
  - **`pagehide`.** It sends `sendWindowClosing()`.
  - **Old server.** On a `ready` without the flag in a detached window: toast "This server does not support detached
    windows", the New-tab page, no reclaim, no self-close.

  Tests:
  - reclaim after reconnect;
  - no reclaim of a tab another window holds;
  - a tab moved to main is not reclaimed on a reconnect;
  - self-close on the last tab moved out;
  - no close while reclaiming, then a close when it clears;
  - the fallback page when `close` is refused;
  - the old-server path.

  (Spec: "Ownership is in memory and a window reclaims its tabs", "A detached window with no tabs closes".)
- [x] 4.4 Chrome, shortcuts and cleanup:
  - **Not rendered when `detached`:** `DockPanel`, `.wco-titlebar`, the drawer, the TabSheet, the review bar and
    the extra-keys bar. The root class is `app detached`.
  - **`+` and dock views.**
    - In `openNewTab`, `detached` sets `newTabDialog` state. That renders the kit `Dialog`
      (`data-testid="newtab-dialog"`) holding `DashboardBody`, with the props the dock passes. `createTab` closes
      it.
    - `openDockView` returns at once when `detached`.
    - `actionHandlers` leaves out `settings` and `openSourceControl` when `detached`, and the palette follows.
    - `historyAction` uses `setPanel('dictationHistory')` when `detached`.
  - **Ctrl+W.** Remove the pop-out exception in the Ctrl+W effect.
  - **Legacy addresses (`session-url.ts` `readBootIntent`):** `/popout/<id>` and `/<id>?popout=1` now return
    `{ kind: 'detached', wid: newWindowId(), tab: id, legacy: true }`.
  - **Deleted:**
    - the popout bar JSX, `openerGone`, `returnToMain`, the opener `message` listener;
    - `openPopout`, `POPOUT_RETURN`, `postReturnToMain` and the `popout` intent kind in `session-url.ts`;
    - `.popout-bar` and the `.app.popout` selector in `client/src/index.css`, keeping
      `.app.mobile .content-area { --group-strip-h: 0px }`.
  - **Realigned:**
    - `groups-css.test.ts:95`;
    - the pop-out tests in `App.test.tsx` ("on a phone or in a pop-out", "a pop-out", "pop-out return button",
      "lets a pop-out window close", and `:5172-5179` "is absent from the pop-out bar, which keeps its brand");
    - `useEditorGroups.test.ts:634-647`;
    - `PaneHost.test.tsx:167`;
    - `SessionTabs.test.tsx:525-597`;
    - `session-url.test.ts:52-58,122-128`.

  New tests:
  - no rail in a detached window;
  - `+` opens `newtab-dialog`;
  - a terminal created there attaches with `window`;
  - Ctrl+W closes the tab;
  - the Settings chord does nothing and writes no dock view.

  (Spec: "A detached window is an editor-groups window without the dock", "A detached window opens new tabs in
  itself", "Dock shortcuts do nothing in a detached window".)
- [x] 4.5 `client/src/session/workspaceController.ts`:
  - Replace `popout` in ctx with `detached`.
  - In a detached window, `sessionsBroadcast` returns no New-tab effect for an empty list (self-close owns it), and
    close-navigation is reconcile's (groups are on).

  Update `workspaceController.test.ts:84,175`.

## 5. Cross-window drag (depends on 4)

- [x] 5.1 `client/src/App.tsx`:
  - **Start.** `externalDrag` state comes from a capture `dragover` listener on `window`, and only when
    `dragTabIdRef.current === null`. A drag with `TAB_DND_TYPE` and without `TAB_DIRTY_DND_TYPE` sets it true and
    restarts a 1000 ms idle timer (it was 300 ms; measured 2026-10-28, a still pointer repeats `dragover` only every ~352 ms). A drag with `TAB_DIRTY_DND_TYPE` restarts the same timer without setting it. The
    timer clears both `externalDrag` and `dirtyToastRef`.
  - **Clear** it on `drop` (one tick later, as `dragTabId` is), and on `dragleave` with `relatedTarget === null`
    and `clientX/clientY` outside `innerWidth`/`innerHeight`.
  - **Wiring.** Pass `externalDrag` to `GroupsView` and every strip. `dropOnEdge(side, id)`, `dropOnCentre(id)`
    and `onDropFromOtherPane(id)` use `id` when `dragTabIdRef` is null.
  - **A tab from another window** (in `tabsRef` but not in `visibleTabsRef`):
    `if (moveTabsToWindow([id], myWindow)) groups.place({ id, leafId, where })`.
  - **A drag carrying `TAB_DIRTY_DND_TYPE`** with `dragTabIdRef.current === null` (foreign: `getData` is hidden
    until drop, so "foreign" is "no local drag is live") sets no `externalDrag` and mounts no overlay. In
    `SessionTabs.tsx` the strip root and pill `onDragOver` (`:744-751`, `:639-647`) return without
    `preventDefault` for it when the strip's `dragTabId` prop is null, and `commitDrop` (`:462-472`) returns before
    `onDropFromOtherPane`. Since nothing cancels its `dragover`, no `drop` fires; the receiver's capture `dragover`
    listener shows the toast "Save the file before moving it to another window" on the FIRST such `dragover`,
    guarded by a `dirtyToastRef` that the same 1000 ms idle timer clears, so it shows once per entry into the
    window.
  - **The source window,** in App's window-capture `dragend` listener (`:1341-1357`), reads
    `e.dataTransfer.dropEffect`. `localDropRef` is set by the capture `drop` listener and cleared on `onDrag(id)`.
    On `dropEffect === 'move'` with `localDropRef` false and `dirtyRef.current[id]` false it applies the move
    optimistically (a dirty editor never moves on a dragend: only a palmux receiver could have taken it, and a
    palmux receiver refuses it): the tab leaves this window, and the 2 s expiry brings it back if the server never moved it.
  - **On the New-tab page,** render one centre `GroupDropOverlay` over `.content-area` while `externalDrag` is set.
    Its drop does the same with `leafId` = the focused leaf and `where: 'centre'`.
- [x] 5.2 `client/src/session/GroupDropOverlay.tsx`: the callbacks become `onDropEdge(side, id: string | null)` and
  `onDropCentre(id: string | null)`, with the id read via `getData(TAB_DND_TYPE)`.

  `client/src/session/GroupsView.tsx` mounts overlays when `dragTabId !== null || externalDrag`. When
  `externalDrag` is set, `canCentre` and `canSplit` are true for every pane.

  `client/src/session/SessionTabs.tsx`: `foreignDrag` is also true with the `externalDrag` prop, so the strip lights
  `drop-into` and draws no bar. Its drop calls `onDropFromOtherPane(id)`.

  Tests in `GroupDropOverlay.test.tsx`, `GroupsView.test.tsx`, `SessionTabs.test.tsx` and `App.test.tsx`:
  - a synthetic `dragover` with the tab type and no local drag mounts overlays;
  - an edge drop sends `moveToWindow` and splits once the broadcast lists the tab;
  - the New-tab page drop;
  - the 1000 ms clear;
  - a local drop is unchanged;
  - a dirty-editor drag mounts no overlay;
  - a dirty foreign drag on a strip resolves no boundary and calls no handler (`SessionTabs.test.tsx`);
  - a dirty foreign drag toasts once while it hovers;
  - a dirty source tab is not removed on a `move` dragend;
  - the source drops the tab on a `move` dragend.

  (Spec: "Tabs move between windows by drag and drop", "A window on the New-tab page takes an external drop", "An
  external drag ends cleanly".)

## 6. Docs and verification

- [x] 6.1 Update `CLAUDE.md`.
  - **Rewrite the pop-out passages** at lines 57, 105, 124, 129-130, 206, 223-230, 281, 304, 358 and 699-700 for
    detached windows.
  - **Line 84.** The sentence "Tabs, groups and order stay server state and stay synchronised across every window;
    only the SELECTION is local" becomes: tabs, groups and order are server state; which WINDOW shows a tab is
    server state too; the selection is local.
  - **Add a "Detached windows" section** stating D1–D15, the accepted risks and the server-restart need.
  - **Legacy `/<id>` boot.** It is no longer parked at mount: like `?new=1` it is applied inside the first `sessions`
    handler (so the D15 guard sees both lists), and a legacy id another window holds boots as a plain `/` would.
    Update the "Editor groups" `show` paragraph and the drawer-stagger sentence that describe the parked legacy show,
    "A popout or a legacy `/<id>` names its tab outright and waits for nothing" (legacy now waits one broadcast), and
    "`?new=1` and a legacy `/<id>` still outrank any stored value" (add: unless another window holds that tab).
  - **Update `tips/tips.ts` "Panes (desktop)"** with the new-window and drag-between-windows tips.
- [x] 6.2 Full gates: `yarn typecheck`, `npx oxlint packages`, `yarn workspace @palmux/client vitest run`,
  `yarn workspace @palmux/server vitest run`, and `npx openspec validate detached-windows --strict` (after
  `split-editor-groups` is archived).
- [x] 6.3 Browser e2e on the isolated smoke server (never :44040), with two windows of one Chromium context.
  Screenshots go in `~/.agent/diagrams/palmux-detached-shots/`. The checks:
  1. open in new window moves the tab;
  2. split inside the detached window;
  3. drag main → a detached pane edge forms a split;
  4. drag back to a main strip;
  5. Move to main window;
  6. close the detached window: the tabs return within about 3 s, still running;
  7. reload the detached window: it keeps its layout;
  8. `+` in a detached window opens the dialog and creates there;
  9. no "Opened somewhere else." on any path;
  10. measure the `dragover` cadence (the D8 assumption);
  11. a drop on the main window's New-tab page.
  Done 2026-10-28 (Chrome 156, Linux X11, native XTEST pointer): all 11 pass after three fix rounds: the idle
  timer 300 → 1000 ms (a still pointer repeats `dragover` every ~352 ms), `dragenter` accepted like `dragover`,
  and ownership-aware eviction (`detached.moved`, design D8), because the source's `dragend` hold proved
  unreliable (the pill is often unmounted first, and `dropEffect` read `none` on most accepted drops).
- [ ] 6.4 Ask the owner for the production server restart, which costs every live terminal. Only after an explicit
  OK, build the client (`yarn workspace @palmux/client build`) and restart. Both land together.
