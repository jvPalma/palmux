# Design

## Context

The pop-out today:

- `/popout/<id>` boots a client with `popout = true` (`App.tsx:320`). Editor groups are off there
  (`groupsEnabled = !mobileActive && !popout`, :693), so `useEditorGroups` draws one virtual pane over every
  tab, and the window writes no storage key.
- The window keeps `.popout-bar` with "return to main" (:2573-2595), and the main window still holds the tab.
- A terminal is taken over by the last attach. The main pane shows "Opened somewhere else." with Take back.
- There is no server route for `/popout/`. The SPA not-found handler serves `index.html`
  (`server.ts:1670-1679`).

Facts this design rests on (recon, 2026-10-27):

- **The control socket carries no identity.** `wsControlUrl()` is a bare `/ws?control=1`, and `WsClient` fixes
  its URL at construction (`ws.ts:52`). Per-socket server state is a `connections` set (:1703).
- **`sessions` is the same string for every socket** (`sessionsMessage`, :1745-1752). `registry.tabs()`
  (:691-703) lists `TabMeta` fields explicitly. `persist` (:439-458) and the restore (:343-373) whitelist the
  `tabs.json` fields, so a new record field does not leak into the file.
- **The server has no `moveTab` message.** `moveTab` is a client layout operation.
- **A terminal exists on the server only once a data socket attaches to its id** (`registry.get(id, spawn)`).
  The tmux target already rides that attach URL and applies only when that call spawns. The window claim
  reuses the same hook.
- **Order sends must carry the full order.** `forgivingOrder` (`shared/tab-order.ts:37-51`) appends any id the
  request omits AT THE END, so a filtered order would move another window's tabs to the tail on every reorder.
- **`window.open` copies the opener's `sessionStorage`.** That is browser behaviour, not measured in this repo.
  A detached window that read `palmux-layout` would boot from the main window's panes.
- **DnD across windows.** `TAB_DND_TYPE` (`SessionTabs.tsx:37`) data is readable on drop in another
  same-origin window, and `dataTransfer.types` is visible on `dragover`. Overlays mount only while the
  window-local `dragTabId` is set (`GroupsView.tsx:280-296`). The strip's `foreignDrag` depends on it too
  (`SessionTabs.tsx:378`). `pane-grid.moveTab` returns the layout unchanged for a tab no pane holds.
- **`openNewTab` opens the DOCK's `'newtab'` view** (`App.tsx:1804-1815`). A window without a dock has no
  chooser host.
- **The New-tab page (`chooserPage`) unmounts every pane.** It cannot be the `+` host in a window that still
  has other panes showing.

## Goals / Non-Goals

**Goals:**
- One tab, one window: a detached window holds tabs that no main window shows, on any device.
- A detached window is the same editor-groups window minus the dock.
- Tabs cross between windows by menu and by drag, onto a strip, a pane's centre or a pane's edge.
- Closing, sleeping, reloading and a server restart never kill a tab or strand it.

**Non-Goals:**
- Dragging past the browser window's edge to spawn a window.
- Detached windows on the mobile layer.
- A dock in a detached window.
- Remembering detached windows across a browser restart.
- A cross-window "Close other tabs".

## Decisions

### D1. Window identity is minted by the opener and lives in the address

`newWindowId()` returns `'w' + 10` base-36 characters from `crypto.getRandomValues`. `isWindowId`
(`/^w[0-9a-z]{6,16}$/`) lives in `shared/protocol.ts`, so the server validates with the same rule. The detached
window's address is `/window/<wid>`. `readBootIntent` gains `{ kind: 'detached', wid, tab?: string }`, with
`tab` read from `?tab=` and removed with `replaceState`. `/popout/<id>` and `/<id>?popout=1` become
`{ kind: 'detached', wid: newWindowId(), tab: id, legacy: true }`. For those, the window itself sends the
`moveToWindow` (nobody else knows the wid) and normalises the address to `/window/<wid>`. The `popout` flag
in App becomes `detached = boot.kind === 'detached'`, and `myWindow = detached ? boot.wid : null`.

*Rejected:*
- An id in `sessionStorage`: the opener's storage is copied, so two windows would share it.
- The window NAME: it is not readable reliably across a reload in every browser, and it is a dedupe key today,
  not an identity.

### D2. Ownership is a server field, in memory

- `TabRecord.window?: string` is emitted by `tabs()` and parsed by `parseTabMeta` (`window` added to its
  copied strings, gated on `isWindowId`).
- It is NOT added to `PersistedTab`. The zoom-out review argued against persistence. A restart is rare and
  already costs every terminal, and the reclaim (D6) restores ownership without a second restore path.
- Ownership dies with the record (exit, kill).

*Rejected:* per-device ownership over `BroadcastChannel`. The owner chose "every device" (2026-10-27).

### D3. Two messages

**`moveToWindow { ids: string[], window: string | null }`** (client → server).

- The server sets or clears `window` on each listed id it knows, ignores unknown ids, and validates `window`
  with `isWindowId`.
- It then broadcasts `sessions` once. It sends no `tabCreated`-style answer; the broadcast is the answer.
- It does not touch order or groups. A tab keeps its server position, so a window that receives it draws it
  where the order puts it.

**`windowClosing {}`** (client → server, detached windows only).

- It is sent from `pagehide`. The server marks that socket so that its close starts the SHORT grace (D4).
- It exists because, without it, closing a detached window makes the user wait the full 15 s before the tabs
  come back.
- A reload also fires `pagehide`. The short grace (3 s) is longer than a local reload, and a slower reload is
  covered by the reclaim (D6).

`createTab` gains an optional `window`. The server sets it on the new record before the broadcast. The data
socket gains `&window=<wid>`: `registry.get(id, { command, window })` applies `window` ONLY in the branch that
creates the record for a new id (`server.ts:643`, before `listChanged()`). A dormant record that respawns (a restored
terminal after a restart) is never claimed by its attach: ownership of an existing tab changes only by
`moveToWindow`. This is narrower than the tmux target, which applies to a dormant respawn too.

### D4. Lease and grace, per window id

The server keeps `windowSockets: Map<wid, Set<WebSocket>>`. A control socket whose URL carries a valid
`window` param is added on connect and removed on close.

- **A timer starts** when an id holds at least one tab and has no socket. This happens on a socket close, and
  on a `moveToWindow` to an id with no socket yet. The timer is 3 s if the closing socket sent
  `windowClosing`, otherwise 15 s.
- **A socket connecting for the id clears its timer.**
- **When the timer fires**, every tab with that `window` is cleared, then one broadcast is sent.
- **Timers `unref()`,** so they never hold the process up on shutdown. They are not cleared there, because a socket's
  close fires after `terminate()` and would re-arm one anyway.

Constants: `WINDOW_GRACE_MS = 15_000` and `WINDOW_CLOSE_GRACE_MS = 3_000`, exported for tests.

*Rejected:*
- Releasing on close at once: a reload would bounce every tab through the main window.
- A heartbeat message: the socket already carries ping/pong, and its close is the signal.

### D5. Each window reads one filtered list; the full list stays for ids and order

App keeps `tabs` (the full list, as broadcast) and derives
`visibleTabs = useMemo(() => visibleOf(tabs, optimisticWindow), [tabs, optimisticWindow])`, where
`visibleOf(list, overrides)` keeps the tabs whose owner (the override when one exists, else `t.window ?? null`)
is `myWindow`. The memo keeps its identity while both inputs do. When the filter removes nothing, `visibleTabs` is `tabs` itself, so a main window
with no detached windows renders exactly as today.

`tabsRef` stays the FULL list, and a new `visibleTabsRef` is written beside it, in the same places
(synchronously in the `sessions` handler and in every optimistic drop). Every write of it is
`visibleOf(tabsRef.current, optimisticRef.current)`, so a stale in-flight frame cannot drop the override.

The `pending` and `seenTermIds` loops in the `sessions` handler iterate the FULL `msg.tabs`. If both windows
pick the same lowest-free terminal id, the id is listed under the other window, reconcile drops it from this
window's pane, and this window never stays attached to another window's shell.

| Readers of `visibleTabs` / `visibleTabsRef` | Readers that stay on the FULL list |
|---|---|
| `useEditorGroups({ tabs })` (reconcile, boot, restore, `prevOrder`, `stripTabs`) | `freshTerminalId` / `nextFreeId` |
| every strip's `allTabs` (so bulk close stays in the window) | `tabOrder` |
| the drawer | `doReorder` / `moveGroup` / `moveTabInTree` / `moveGroupInTree` / `applyDrop` |
| the controller ctx's `tabs` (close-navigation, the empty-list New-tab rule) | `afterLastOf` |
| `selectionFor` / `resolveStoredSelection` | `refOfTab` (kind lookup) |
| the review-tab readers, including `activeTab` | |
| `stripOf` | |
| `useTabGroups` `tabs`/`tabsRef` (collapse, switch, `groupCloseAll`, `removeFromGroup`) | `useTabGroups`' new `fullTabsRef`, read only by `addToGroup` to build `groupUpdate.order` |
| `GroupsView`'s `tabs` (it feeds `PaneHost`, which mounts a hidden pane per non-terminal tab in the LIST) | |
| `leaveReview`'s return-tab lookup | |
| the controller's `sessionsBroadcast` event `tabs` (App dispatches the filtered new list) | |
| the dragged-tab safety net (`dragTabId` clears when the tab leaves THIS window's list) | |

A strip reorder already maps a pane's visible indices onto the full order (`leafTabIds` → `doReorder`). The
window filter is one more subset under that mapping, so the full order goes out with the hidden tabs in place.

### D6. Reclaim on (re)connect

On the first `sessions` broadcast after each control-socket open, a detached window collects the tab ids in its
held or saved layout (`palmux-layout:<wid>`, plus the boot `tab` on the FIRST open only, so a tab later sent to
main is never pulled back by a reconnect) that the list shows with no `window`. It sends
one `moveToWindow` for them, with `window: myWindow`, and adds them to a `reclaiming` set. Ids that another
detached window holds are not claimed and drop out through reconcile.

- **`reclaiming` is React state, not a ref,** so clearing it re-runs the self-close check. It works like
  `pending`: the window does not close while a reclaim is in flight.
- An id leaves `reclaiming` on the next broadcast, whether or not it was granted.
- This covers a reload slower than the grace, a server restart, and the legacy `/popout/<id>` boot.

### D7. Opening a new window

`doPopout(id)` (main or detached):

1. `wid = newWindowId()`.
2. `w = window.open('/window/' + wid + '?tab=' + id, 'palmux-' + wid, 'popup,width=1000,height=640')`.
3. If `w` is null, show the existing toast and stop. Nothing moves.
4. Otherwise send `moveToWindow { ids: [id], window: wid }` and apply it optimistically: `setTabs`, writing
   `tabsRef` and `visibleTabsRef` first. The source window's reconcile drops the tab in the same render. Its
   pane unmounts BEFORE the new window attaches, so no "Opened somewhere else." can appear.

The server starts the 15 s timer for `wid` until the window connects (D4).

**A pending terminal cannot move.** `doPopout` and a cross-window drag refuse an id that is not in `tabsRef` (a
terminal this window picked an id for and no broadcast lists yet), with the toast "Wait for the terminal to start".

**Moving a dirty editor out asks first.** When `window !== myWindow` (the tabs leave this window),
`moveTabsToWindow` checks `dirtyRef` for every editor among the ids. A move INTO this window (a reclaim, a drop
here) never asks: nothing unmounts here. If any is dirty, it asks `window.confirm('<n> editor tab(s) have unsaved changes. Move and discard them?')`, the shape of
`closeManyMessage`, and moves nothing on Cancel. After a confirmed move, the moved ids leave `dirtyTabs`, so `guardedReload` no longer
counts them. The editor unmounts in the window it leaves, and the receiving
window loads the file from disk. A drag cannot ask, because the receiver does not know the source's buffer. So a
dirty editor pill's `dragstart` also sets `application/x-palmux-dirty`, and a receiving window treats a drag
carrying it as no target, on EVERY drop surface. The overlays do not mount. The strip root's and the pill's
`onDragOver` (`SessionTabs.tsx:744-751`, `:639-647`) return without `preventDefault` when the drag carries
`TAB_DIRTY_DND_TYPE` (exported beside `TAB_DND_TYPE`) and no local drag is live (`dragTabId === null`; `getData`
is hidden until drop, so this is the only test of "foreign"), so the browser shows no-drop. `commitDrop` returns
before `onDropFromOtherPane` for such a drag. Since nothing cancels its `dragover`, no `drop` event fires, so the
toast "Save the file before moving it to another window" comes from the receiver's capture `dragover` listener,
once per entry into the window (a `dirtyToastRef` the 1000 ms idle timer clears). A
`web` pane loses its in-frame history on a move; that is accepted.

**An optimistic move holds until the server agrees.** A `sessions` frame already in flight when `moveToWindow` is
sent would carry the old owner and flash the tab back into the source window. App therefore keeps
`optimisticWindow: Map<id, window>` in React STATE (so its expiry re-renders), with one `setTimeout(2000)` per entry
that removes it. `optimisticRef` mirrors the state synchronously: `moveTabsToWindow`, the dragend path, the
handler's confirm removal and the expiry timer each write the ref and then the state. The `visibleTabs` derive
applies it over the broadcast value. The `sessions` handler removes an
entry synchronously when the broadcast shows the tab with that owner, and the timer removes it otherwise (the
server refused or never answered, so the broadcast wins). Nothing removes an entry during render.

### D8. Cross-window drag uses the existing drag data

- **Source window.** `dragstart` already sets `TAB_DND_TYPE` (the bare id) and `effectAllowed = 'move'`.
  Nothing new is needed.
- **Receiving window.** A capture `dragover` listener on `window` sees `types.includes(TAB_DND_TYPE)`. If
  `dragTabId` is null there, it sets `externalDrag = true` and restarts a 1000 ms idle timer (measured: see
  "Risks"). `GroupsView` mounts
  overlays when `dragTabId !== null || externalDrag`.
- **What an external drag allows.** For a tab this window does not show, `canCentre` and `canSplit` are true on
  every pane, because a drop can never be a no-op. The strip treats it as `foreignDrag`, lights `drop-into`,
  and draws no insertion bar.
- **On drop**, read the id with `getData(TAB_DND_TYPE)`:
  - If the tab is in `visibleTabsRef`, it is the local path, unchanged.
  - If it is in the full list, send `moveToWindow { ids: [id], window: myWindow }`, apply it optimistically,
    and park a placement `{ id, leafId, where: 'centre' | Side }` in the hook. In the render where the tab
    first appears in the layout (reconcile adds it, inactive, to the focused pane), the hook applies
    `splitPane(layout, leafId, side, ref)`, or for centre or strip `moveTab` + `activate`. It then focuses the
    target. A placement whose `leafId` is gone falls back to the focused pane.
  - An id in neither list is ignored.
- **The overlay's callbacks take the id.** `onDropEdge(side, id: string | null)` and `onDropCentre(id: string | null)`
  read `getData(TAB_DND_TYPE)` in `GroupDropOverlay`. App uses the id when `dragTabIdRef` is null.
- **A window on the New-tab page** (no pane mounted) renders ONE centre overlay over `.content-area` while
  `externalDrag` is set. A drop sends `moveToWindow` and parks `place({ id, leafId: focused, where: 'centre' })`.
  The tab then becomes the sole leaf's active tab, and the page leaves because `focusedActive` is no longer null.
- **Clearing.** `externalDrag` clears on `drop` (deferred a tick, as `dragTabId` is), on a `dragleave` whose
  `relatedTarget` is null with the pointer outside the viewport, and on the 1000 ms timer.
- **The source window** receives `dragend` in App's existing window-capture `dragend` listener, which reads
  `e.dataTransfer.dropEffect`. A `localDropRef` is set by the capture `drop` listener and cleared on `onDrag(id)`.
  When `dropEffect === 'move'`, `localDropRef` is false and the tab is not a dirty editor (a non-palmux acceptor
  could report `move` for a drag palmux refused), the source applies the move optimistically too (the tab leaves with `window` = unknown-other, which the
  derive treats as "not mine"), so its pane unmounts before the receiver's attach. The 2 s optimistic expiry
  restores it if the server never moved it.
- **That hold is a head start; the server's eviction is the guarantee.** Measured natively (2026-10-28, Chrome
  156, Linux X11, two real windows): the source's `dragend` read `none` in 27 of 49 main → detached drops and
  10 of 12 detached → main drops that the receiver took, and when the move's broadcast renders first the pill
  is gone and `dragend` never reaches `window`. The source pane then left only on the broadcast, 0–2 ms ahead
  of the receiver's attach, and a 150 ms delay on the source's `sessions` handling showed "Opened somewhere
  else." on 6 of 6 drops. So `detached` carries `moved: true` when the evicted socket's window (its
  `&window=`, absent for main) is not the tab's owner (`registry.windowOf`): the tab moved, the broadcast that
  moved it was sent first and takes the pane away, and the pane stops reconnecting and shows nothing. It
  offers Take back only if it is still on that tab after 2 s (`MOVED_TAKEOVER_MS`, the hold's bound). A rival
  in the owning window gets the plain `detached`. The ordering this rests on is the receiver's own:
  `moveToWindow` goes out on its open control socket before its pane opens a new data socket.

*Rejected:*
- A `BroadcastChannel` for the drag id: types are enough before the drop, and the id is readable on it.
- Holding the source on `dragend` with any `dropEffect`, or at `dragstart`: a cancelled drag would hide the tab
  for 2 s, and the event does not reach `window` once the pill has unmounted.
- Making the receiver wait for the broadcast before it attaches: the race is the SOURCE hearing the move late,
  which that does not change (the 150 ms reproduction still evicts a pane that has not heard it).
- A second MIME type naming the source window: the server's ownership already says where a tab is.

### D9. The detached window's chrome

- The app root is `.app.detached`. `DockPanel`, `.wco-titlebar`, the drawer, the TabSheet and the review bar
  are not rendered.
- Strips render as in the main window, so `--group-strip-h` keeps its value. The `.app.popout` rules and
  `.popout-bar` are deleted.
- `groupsEnabled = !mobileActive || detached`, with mobile forced off in a detached window
  (`mobileActive = !detached && …`).
- The tab menu adds "Move to main window" (`detached` only). Mobile hides "Open in new window"
  (`onPopout` undefined when `mobileActive`).
- The `+`: `openNewTab` in a detached window opens a kit `Dialog` (`newtab-dialog`) holding `DashboardBody`.
  `createTab` closes it. The New-tab PAGE stays the empty-window fallback.
- **Shortcuts and palette.** `openNewTab` branches to the dialog when `detached`, and `openDockView` returns at once
  there, so no dock view is ever written to `localStorage` from a detached window. `actionHandlers` leaves out
  `settings` and `openSourceControl` when `detached`, and the palette (`ACTIONS.filter(a => actionHandlers[a])`)
  follows. Everything else keeps working: `tips` and `dictationHistory` are modals, the toast's "Open history"
  uses the modal there, and `dictate`, upload, download, search, export, copy-last-output, diagnostics and the
  review chords act on the focused pane.
- Ctrl+W closes the active tab in a detached window, as in the main window. The pop-out exception at `:1953`
  goes.
- `POPOUT_RETURN`, `postReturnToMain`, `openerGone`, the opener `message` listener and `returnToMain` are
  deleted.

### D10. Self-close

An App effect re-runs on `visibleTabs`, `reclaiming` and `capDetached`, and reads `pending` inside (it is the
hook's mutable `Set`; every pending id leaves on a broadcast that also changes `visibleTabs`). Once the window has seen at least one of its tabs,
`capDetached` is true, and the list is empty with `pending` and `reclaiming` both empty, it sends `windowClosing` and calls `window.close()`. One tick later,
if `window.closed` is still false, it shows the New-tab page. That happens when the address was opened by hand,
and the window then stays usable.

### D11. Layout and selection keys per window

`LAYOUT_STORE_KEY` becomes `layoutKey(myWindow)`: `'palmux-layout'` or `` `palmux-layout:${wid}` ``.
`useEditorGroups` takes the key. `window-selection.ts` uses `` `palmux-window-tab:${wid}` `` in a detached
window and never writes `palmux-last-tab` there. On boot, the detached window passes `bootSelection` = the
`tab` param when it resolves, else null.

### D13. Boot of a detached window

- `awaitingResolve` starts TRUE and `sessionId` starts `''`, as for a plain `/` boot.
- **On the first broadcast,** inside the `sessions` handler and in this order:
  1. `tabsRef.current = msg.tabs`, then `visibleTabsRef.current` is derived from it;
  2. the reclaim (D6) runs and writes its optimistic move into both refs;
  3. the boot selection is resolved from `visibleTabsRef.current`: `boot.tab` when it is there, else
     `readSelection(myWindow)`, else `resolveSelection` over it. There is NO fallback to the device key
     `palmux-last-tab`. The existing `hasSavedLayout()` branch stays: with a saved layout and no remembered tab
     the selection is `null`, so the layout's own focus stands;
  4. `showTab`.
- **The boot-spent effect** calls `history.replaceState(null, '', windowPath(wid))` when `detached`, for a normal
  and a legacy boot alike. It never writes `/`. This is what removes `?tab=`.
- **The persist effect** writes `writeSelection(sel, myWindow)` and NEVER calls `writeLastTab` when `detached`.

### D15. One guard against showing a hidden tab

`setSessionId` (the choke point) and the controller's `tabCreated` navigate IGNORE an id that is in `tabsRef` but not
in `visibleTabsRef`. Without the guard, any navigation to another window's tab resolves its kind from the full
list, `show` adds it to a pane, a TerminalPane attaches, and the other window shows "Opened somewhere else." The
paths it closes:
- a `tabCreated` answering an idempotent review create that raced D14;
- `leaveReview`;
- any later `selectTab`.

`moveTabsToWindow` writes the refs BEFORE it navigates, so its own navigation passes the guard.

### D14. Opening a review or file that another window holds

A review `createTab` is idempotent on the server, so a detached window asking for a review the main window holds
would get back an id it never shows. The client checks the FULL list first: a live review with that url in
another window is moved here (`moveTabsToWindow([id], myWindow)`) and shown, and no `createTab` is sent. The tab
moves to the window that asked; VS Code would focus it in the other window instead. This is the simpler of the
two, and it is consistent with one tab per window. A review holds no unsaved state, so nothing can be lost.

An editor file tab (`openFileTab`) for a path another window holds is NOT moved: this window cannot see the other
window's buffer, so D7's dirty confirm would be blind and a dirty editor would lose its text. It shows the toast
"`<name>` is open in another window" and sends nothing.

### D12. Migration and compatibility

- **The server announces the capability.** `ready` gains `detachedWindows?: true`. A client offers "Open in
  new window" (and runs D7) only when its last `ready` carried it.
- **An older server** (before the restart) sends no flag. The item is hidden, so a new client build deployed
  ahead of the restart does not open windows that would show nothing.
- **A detached window that reconnects to an older server** (a rollback) receives no flag. It shows the New-tab
  page with a toast, "This server does not support detached windows", and claims nothing.
- **An older client on a new server** ignores `window`, because its `parseTabMeta` drops the field. It shows
  every tab, as today, and its pop-out still works as the old takeover.
- **`tabs.json` is unchanged.** Rolling back the server releases all ownership, which is harmless.

## Risks / Trade-offs

- **A live but idle detached window hides its tabs from the phone.** This is the owner's choice. There is no way
  to pull a tab from the phone except closing that window. A "Move to this device" row in the drawer is the
  follow-up if it bites.
- **Reload slower than 3 s after `pagehide`.** The tabs flash into the main window, which attaches the
  terminals, and the reclaim then moves them back. The main pane unmounts, so last attach wins without a fight.
  Cost: one extra SIGWINCH and a brief reorder in main.
- **The cross-window DnD timer is measured.** The native e2e (2026-10-28, Chrome 156 on Linux X11, a native
  XTEST pointer, two real windows) measured one `dragover` every ~352 ms while the pointer is STILL (351–353,
  n=8; the HTML spec's nominal repeat is 350 ms). The first build's 300 ms timer fired between two repeats and
  unmounted the overlay, and the next repeat found nothing to cancel it: releases after a still hold of 0, 100
  and 250 ms landed, holds of 330, 350, 400, 700 and 1000 ms were all lost (0/5), and the source's `dragend`
  read `none`. The timer is 1000 ms now. A drag that leaves the viewport is cleared by its `dragleave` within
  ~18 ms, so the timer only bounds a drag whose end the browser never reports here, where a long one costs an overlay
  left up for a second. The same run showed that Chromium fires only `dragenter` on the element a drag has just moved onto,
  and that answer is the drop operation until the next `dragover`, so the strip root, each pill, each chip and
  each pane overlay accept on `dragenter` as well. What would invalidate the measurement: an engine or OS whose
  still-pointer repeat is slower than the timer; macOS, Windows and Firefox are unmeasured.
- **Groups spanning windows.** Each window draws only its members, and contiguity stays a server rule. A join or
  leave from one window carries the full order (D5), so nothing is pushed to the tail.
- **Server restart.** The feature ships with a server change, and restarting costs every live terminal (a cold
  start plus snapshot restore). The client-only parts degrade as D12 says until the restart.
- **Observability.** The server logs `window <wid> released <n> tabs (grace|closing)` at info. The diagnostics
  overlay needs nothing new.
- **A duplicated detached window shares its wid.** A popup window has no tab strip, so the browser's "Duplicate"
  is not offered. Opening `/window/<wid>` by hand in a second window would show the same tabs twice (two
  attachments, last attach wins). Accepted, not guarded.
- **Cost.** No dependency and no new storage. One timer per detached window id while its socket is closed.
