# Spec Delta

## ADDED Requirements

### Requirement: Open in new window moves the tab into a detached window

On the desktop, the tab menu's "Open in new window" SHALL move the tab into a new detached window, never mirror
it. The window the tab left SHALL stop showing it as soon as the request is sent, so a terminal is never attached
from both windows. The mobile layer SHALL NOT offer the item.

#### Scenario: Opening a terminal in a new window moves it

- **WHEN** the user picks "Open in new window" on terminal tab 3 in the main window
- **THEN** a detached window opens showing tab 3, the main window's strip no longer lists tab 3, and no window
  shows "Opened somewhere else."

#### Scenario: Works for every kind

- **WHEN** the user opens an editor tab in a new window
- **THEN** the detached window shows that editor bound to the same note, and the main window no longer lists it

#### Scenario: The phone offers no new window

- **WHEN** the user long-presses a tab on the mobile layer
- **THEN** the sheet has no "Open in new window" item

#### Scenario: A blocked popup moves nothing

- **WHEN** the browser blocks the new window
- **THEN** a toast says so, and the tab stays where it was

### Requirement: A detached window has an id and an address

A detached window SHALL have a window id, `w` plus 10 random base-36 characters, checked by a shared `isWindowId`
(`/^w[0-9a-z]{6,16}$/`) and minted by the window that opens it. Its address SHALL be `/window/<wid>`, kept across
reloads. A first load MAY carry `?tab=<id>`, consumed once at boot and removed with `replaceState`. A main window
SHALL have no window id.

#### Scenario: A detached window keeps its address

- **WHEN** the user reloads a detached window at `/window/wq3k9x2m1ab`
- **THEN** it comes back as the same detached window, at the same address, with its own tabs

#### Scenario: A malformed window address is the main window

- **WHEN** a window is opened at `/window/` followed by a string that fails `isWindowId`
- **THEN** it boots as a main window at `/`

### Requirement: The old pop-out addresses open a detached window

`/popout/<id>` and `/<id>?popout=1` SHALL still resolve. Each SHALL mint a window id, move tab `<id>` into it, and
normalise the address to `/window/<wid>`.

#### Scenario: The legacy pop-out address still resolves

- **WHEN** a window is opened at `/popout/3` or `/3?popout=1`
- **THEN** it becomes a detached window holding tab 3, and its address normalises to `/window/<wid>`

### Requirement: A tab is shown by exactly one window

The server SHALL record which detached window holds a tab (`TabMeta.window`, a window id; absent means the main
window). Every main window, on every device, SHALL show only tabs with no `window`. A detached window SHALL show
only tabs whose `window` is its id. A window's strips, panes, drawer, New-tab rule and close-navigation SHALL read
only the tabs it shows.

#### Scenario: The phone hides a detached tab

- **WHEN** tab 3 is held by a detached window on the desktop
- **THEN** the phone's drawer and every main window on any device do not list tab 3

### Requirement: Shared order and ids stay whole across windows

Allocating a terminal id SHALL read the FULL tab list. A reorder or group order sent to the server SHALL carry the
FULL order, with the tabs other windows show kept in place. "Close other tabs", "Close tabs to the right" and a
group's "Close all" SHALL be computed over the tabs this window shows, and SHALL never close a tab another window
shows.

#### Scenario: A reorder in one window does not move the other window's tabs

- **WHEN** the main window shows tabs 0, 2, 4, a detached window holds 1 and 3, and the user drags tab 4 before
  tab 0 in the main window
- **THEN** the order sent puts 4 first and keeps 1 and 3 in their places relative to the others, not at the end

#### Scenario: Close other tabs stays inside the window

- **WHEN** the user picks "Close other tabs" on a tab in a detached window
- **THEN** only that window's other tabs are closed, and the main window's tabs keep running

#### Scenario: A group's Close all stays inside the window

- **WHEN** group G has members 1 and 2 in the main window and member 3 in a detached window, and the user picks
  Close all on G in the main window
- **THEN** tabs 1 and 2 close and tab 3 keeps running

#### Scenario: A fresh terminal never reuses a hidden id

- **WHEN** the main window shows tab 0, a detached window holds tab 1, and the user opens a new terminal in the
  main window
- **THEN** the new terminal takes id 2, not 1

### Requirement: A detached window is an editor-groups window without the dock

A detached window SHALL draw the editor-groups layout as the main window does (pane tree, strips, sashes, drop
regions, Split right and Split down, a strip's `+`). It SHALL NOT render the dock rail, the dock, the topbar or a
pop-out bar, and SHALL ignore the mobile layer. Its commands SHALL be in the tab menu.

#### Scenario: Split inside a detached window

- **WHEN** the user drags a tab in a detached window onto the right edge of its pane
- **THEN** a second pane forms on the right in that window, as it would in the main window

### Requirement: A detached window keeps its own layout

A detached window SHALL save its layout in `sessionStorage['palmux-layout:<wid>']`. It SHALL NOT read the main
window's `palmux-layout` or `palmux-window-tab`, which `window.open` may have copied, and SHALL NOT write
`palmux-last-tab`. With no saved layout it SHALL open one pane holding every tab it holds, the `?tab=` tab active.

#### Scenario: The copied main layout is ignored

- **WHEN** the main window holds three panes and opens a tab in a new window
- **THEN** the detached window opens with one pane holding that tab, not the main window's three panes

### Requirement: A detached window opens new tabs in itself

A strip's `+` in a detached window SHALL open the New-tab chooser (`DashboardBody`) in a kit `Dialog`, because the
window has no dock. A tab created there SHALL open in that window's focused pane.

#### Scenario: New tab from a detached window

- **WHEN** the user presses a strip's `+` in a detached window and picks a terminal
- **THEN** a new terminal opens in that pane of the detached window, and no main window lists it at any moment

### Requirement: A tab created in a detached window is born there

A terminal created in a detached window SHALL be claimed when it spawns: its data socket SHALL carry
`&window=<wid>`, and the server SHALL set `window` only when that attach creates the record for a NEW id (never
for a dormant record respawning, such as a restored terminal). Any other kind created
there SHALL carry the window id in `createTab`. No broadcast SHALL list such a tab without its window.

#### Scenario: A new terminal never flashes in main

- **WHEN** a terminal is created in a detached window
- **THEN** the first broadcast that lists it already names the detached window

#### Scenario: An attach to an existing terminal claims nothing

- **WHEN** a data socket with `&window=<wid>` attaches to a terminal that is running, or to a dormant restored
  terminal that it respawns
- **THEN** the tab's `window` is unchanged

### Requirement: Tabs move between windows by drag and drop

A palmux window SHALL accept a tab dragged from another palmux window of the same browser, on the same targets as
a local drag: a strip or a pane's centre (into that pane) and a pane's edge (a new pane on that side). The
transport SHALL be the existing tab drag data: `dataTransfer.types` containing the tab type turns the overlays on,
and the id is read on drop. A drop SHALL send `moveToWindow` and place the tab at the target when it first appears.

#### Scenario: Drag from main to a detached window's edge

- **WHEN** the user drags tab 5 from the main window onto the bottom edge of a pane in a detached window
- **THEN** the detached window gains a pane below holding tab 5, and the main window no longer lists tab 5

#### Scenario: Drag back to the main window

- **WHEN** the user drags a tab from a detached window onto a main-window strip
- **THEN** the tab joins that pane in the main window and leaves the detached window

### Requirement: A window on the New-tab page takes an external drop

A window on the New-tab page SHALL accept an external tab drop anywhere over its content area, into its one pane.

#### Scenario: Drop on a window that shows the New-tab page

- **WHEN** every tab of the main window has been moved out, and the user drags a tab from a detached window over
  the main window's New-tab page and drops it
- **THEN** the main window shows that tab in its one pane

### Requirement: An external drag ends cleanly

A window SHALL clear an external tab drag on a drop, when the drag leaves the viewport, and when no `dragover` has
arrived for 1000 ms (a still pointer repeats `dragover` only about every 350 ms). A drop of a tab the window already shows SHALL be an ordinary local drop.

#### Scenario: An abandoned external drag leaves no overlay

- **WHEN** a tab drag from another window passes over this window and is released outside it
- **THEN** this window's drop overlays are gone within 1000 ms of the last `dragover`

#### Scenario: A release right after the pointer stops or enters a target lands

- **WHEN** a tab drag from another window rests still over a strip or a pane for longer than one `dragover`
  repeat, or is released right after the pointer moves onto a strip pill
- **THEN** the drop lands as it would after continuous movement

### Requirement: Move to main window returns a tab

A detached window's tab menu SHALL offer "Move to main window", which releases the tab to the main window. It SHALL
also keep "Open in new window", which moves the tab into another new detached window. A main window SHALL NOT offer
"Move to main window".

#### Scenario: Dock shortcuts do nothing in a detached window

- **WHEN** the user presses the Settings shortcut in a detached window
- **THEN** nothing opens there, the command palette does not list it, and the main window's dock view is unchanged

#### Scenario: Move a tab back from the menu

- **WHEN** the user picks "Move to main window" on a tab in a detached window
- **THEN** the tab appears, inactive, in the focused pane of every main window, and leaves the detached window

### Requirement: Ownership lives while the window lives

The server SHALL tie a window id's ownership to that window's control sockets (`/ws?control=1&window=<wid>`).
When the id holds tabs and has no open control socket, a grace timer SHALL start: 3 s after the window sent
`windowClosing` (on `pagehide`), otherwise 15 s. When it fires, the id's tabs SHALL be released and broadcast. A
control socket for the id SHALL cancel it. A `moveToWindow` to an id with no socket SHALL start the 15 s timer.

#### Scenario: Closing the detached window returns its tabs

- **WHEN** the user closes a detached window holding terminals 1 and 3
- **THEN** within about 3 s tabs 1 and 3 appear in every main window's focused pane, still running

#### Scenario: A reload keeps the window's tabs

- **WHEN** the user reloads a detached window
- **THEN** it comes back with its panes and tabs

#### Scenario: A laptop that sleeps gives the tabs back

- **WHEN** the machine holding a detached window sleeps and its socket stays closed for more than 15 s
- **THEN** the tabs it held appear on the phone and in every main window

#### Scenario: A window that never loads releases its tab

- **WHEN** a tab is moved into a new window that never connects
- **THEN** the tab returns to the main window after 15 s

### Requirement: Ownership is in memory and a window reclaims its tabs

Ownership SHALL NOT be written to `tabs.json`, so a server restart releases every tab. A detached window SHALL, on
the first `sessions` broadcast after each connect, send `moveToWindow` for the tabs in its saved layout that have
no `window`. The tab the window was opened for (`?tab=`) SHALL be included on the FIRST connect only.

#### Scenario: A tab sent to main is not reclaimed on a reconnect

- **WHEN** the user moves the tab a detached window was opened for back to main, and the window's socket later
  reconnects
- **THEN** the tab stays in the main window

#### Scenario: A restart gives the window its tabs back

- **WHEN** the server restarts while a detached window holds tabs 1 and 3, and the window reconnects
- **THEN** the window reclaims 1 and 3 into the panes it had, and the main window stops listing them

#### Scenario: A reclaim never takes another window's tab

- **WHEN** a reconnecting detached window's saved layout names a tab another detached window now holds
- **THEN** the reconnecting window does not claim it and drops it from its layout

### Requirement: Opening a review or file another window holds

When a window opens a review whose url another window holds, it SHALL move that review tab into itself and show it,
and SHALL NOT create a second review. When a window opens a file whose editor tab another window holds, it SHALL
show the toast "`<name>` is open in another window" and SHALL change nothing, because it cannot see that window's
unsaved text.

#### Scenario: A review held by the main window moves

- **WHEN** the main window shows the Changes review of a project, and a detached window opens a file of that review
- **THEN** the review tab moves into the detached window and scrolls to the file, and the main window no longer
  lists it

#### Scenario: A file held by another window stays there

- **WHEN** the main window holds an editor tab for `/home/u/notes.md`, and a detached window opens that file
- **THEN** the detached window shows "notes.md is open in another window", and the editor stays in the main window
  with its text

### Requirement: A detached window with no tabs closes

When a detached window's list becomes empty after it held a tab, with nothing pending or being reclaimed, and the
server supports detached windows, it SHALL send `windowClosing` and call `window.close()`. If the browser refuses (the address was opened by hand), it SHALL show
the New-tab page.

#### Scenario: The last tab leaves

- **WHEN** the user drags the only tab of a detached window into the main window
- **THEN** the detached window closes

### Requirement: Detached windows need a server that supports them

The server SHALL announce `detachedWindows: true` in `ready`. A client SHALL offer "Open in new window" only when
its last `ready` carried it. A detached window whose `ready` lacks it SHALL claim nothing and show the New-tab page
with a toast.

#### Scenario: A new client on an old server hides the item

- **WHEN** the client build is newer than the running server
- **THEN** the tab menu offers no "Open in new window"
