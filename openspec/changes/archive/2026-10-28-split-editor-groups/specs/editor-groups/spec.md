# Spec Delta

## Purpose

Desktop editor groups as in VS Code: the content area is a grid of panes, each with its own tab strip, built and
rearranged by dragging tabs, resized by sashes, and saved per window.

## ADDED Requirements

### Requirement: Editor groups are desktop-only

Panes SHALL exist only while the mobile layer is inactive. With the mobile layer active, or in a pop-out window,
the client SHALL show a single pane holding the window's selected tab, offer no split command or pane drop target,
and neither read nor write the saved layout.

#### Scenario: A phone shows one pane

- **WHEN** a window saved with three panes is opened with the mobile layer active
- **THEN** the content area shows only the selected tab, the drawer lists every tab as before, and no pane drop
  target or split menu item exists

#### Scenario: A pop-out ignores the layout

- **WHEN** a tab is opened in a pop-out window
- **THEN** the pop-out shows that tab alone and the main window's saved layout is unchanged

### Requirement: The content area is a grid of panes

On a desktop the content area SHALL show one or more panes arranged as a layout tree: a branch splits its space
into a row or a column of children, a leaf is a pane, and branches nest to any depth. Every open tab SHALL belong
to exactly one pane, and each pane SHALL show exactly one of its tabs (its active tab).

#### Scenario: Three columns with a row inside one

- **WHEN** the layout is three columns and the middle column holds two panes stacked
- **THEN** four panes are on screen, each showing its own active tab, all interactive at once

#### Scenario: A tab is never in two panes

- **WHEN** a tab is moved from pane A to pane B
- **THEN** it is listed in B's strip and no longer in A's

### Requirement: Each pane has its own tab strip

Each pane SHALL draw a tab strip above its content listing only that pane's tabs, in the server's tab order, with
the same pills, colour dots, colour-group clusters, context menu, middle-click close and `+` button as the desktop
strip. The `+` button SHALL create the new tab in that pane. No fused split pill SHALL exist.

#### Scenario: Two strips

- **WHEN** pane A holds tabs 1, 3 and 4 and pane B holds tab 2
- **THEN** A's strip shows 1, 3, 4 in server order and B's strip shows only 2

#### Scenario: Plus creates in its own pane

- **WHEN** the user clicks the `+` in pane B's strip and creates a terminal
- **THEN** the terminal becomes pane B's active tab and pane B becomes the focused pane

### Requirement: Exactly one pane is focused

Exactly one pane SHALL be focused. Clicking or tapping inside a pane, or on a tab in its strip, SHALL focus it.
The focused pane's active tab SHALL be the window's selected tab, and keyboard, clipboard, upload and dictation
input SHALL route to it. The focused pane SHALL be marked visibly through its strip, never by animating inside a
terminal.

#### Scenario: Clicking a pane moves input

- **WHEN** panes A and B show two terminals and the user clicks inside B, then uses Upload
- **THEN** B is marked focused and the uploaded path is typed into B's shell

#### Scenario: Focus is the window selection

- **WHEN** the user focuses pane B showing tab 2 and reloads the window
- **THEN** pane B is focused again and tab 2 is the window's selected tab

### Requirement: Dropping a tab on a pane's edge creates a pane

While a tab is dragged over a pane, a pointer in the pane's left, right, top or bottom region SHALL, on drop, create
a new pane on that side of the target pane and move the tab into it as its active tab, and the new pane SHALL be
focused. The regions SHALL be VS Code's: horizontal thirds first (left third, right third), then vertical thirds
(top third, bottom third); the middle cell is the centre.

#### Scenario: First split from one pane

- **WHEN** one pane holds tabs 1 to 5 and the user drags tab 2 to the right third of the pane
- **THEN** two panes are side by side: the left holds 1, 3, 4, 5 and the right holds 2, focused

#### Scenario: A row inside a column

- **WHEN** two columns exist and the user drags a tab to the bottom third of the right column
- **THEN** the right column splits into two stacked panes, the dragged tab in the lower one, and the left column is
  unchanged

#### Scenario: Dragging a pane's only tab to its own edge does nothing

- **WHEN** a pane holds a single tab and that tab is dropped on the same pane's edge
- **THEN** the layout is unchanged

### Requirement: Dropping a tab in a pane's centre or strip moves it there

Dropping a dragged tab in another pane's centre region or on its strip SHALL move it into that pane as its active
tab; the tab keeps its place in the server order, so the target strip shows it among its tabs in that order. Dropping
a tab on its own pane's centre SHALL change nothing; dropping it on its own strip SHALL reorder it.

#### Scenario: Centre drop

- **WHEN** tab 4 in pane A is dropped in the centre of pane B
- **THEN** tab 4 leaves A and becomes B's active tab, and B is focused

#### Scenario: Strip drop keeps the server order

- **WHEN** the server order is 2, 4, 6, tab 4 is in pane A, and tab 4 is dropped anywhere on pane B's strip holding 2 and 6
- **THEN** tab 4 is pane B's active tab, B's strip shows 2, 4, 6, and no reorder is sent

### Requirement: Drops preview the region they claim

While a tab drag hovers a pane, the client SHALL paint a preview over the region the drop would claim: the matching
half of the pane for an edge, the whole pane for the centre, and an insertion marker for a strip position. The
preview SHALL clear on leave, drop or drag end, SHALL NOT animate, and an OS file drag SHALL never show it.

#### Scenario: Right edge preview

- **WHEN** a dragged tab hovers the right third of pane B
- **THEN** the right half of pane B is tinted until the pointer leaves that region

#### Scenario: File drags fall through

- **WHEN** an OS file is dragged over a pane
- **THEN** no pane preview appears and the upload drop handles the file

### Requirement: An empty pane disappears

When a pane's last tab is closed or moved out, the pane SHALL be removed, its space SHALL go to its siblings, a
branch left with one child SHALL be replaced by that child, and focus SHALL move to the pane that took the space.
The last remaining pane SHALL never be removed; with no tabs at all the New-tab page shows as today.

#### Scenario: Moving the last tab out

- **WHEN** pane B holds only tab 2 and tab 2 is dropped in pane A's centre
- **THEN** pane B disappears, pane A fills the space and is focused with tab 2 active

#### Scenario: Closing the last tab

- **WHEN** the user closes the only tab of the middle of three columns
- **THEN** two columns remain and the neighbouring pane takes the freed width

### Requirement: Sashes resize adjacent panes

A sash SHALL sit between every two adjacent children of a branch and SHALL resize them when dragged, clamped so no
pane goes below 15% of its branch. Pane rectangles SHALL update every frame while dragging; a terminal's resize and
the saved layout SHALL be written on release only. While a sash is dragged, framed pages SHALL not receive pointer
events, so the drag is never lost over a web pane.

#### Scenario: Resize on release

- **WHEN** the user drags the sash between two terminal panes and releases it
- **THEN** both panes resize during the drag and each shell receives one resize on release

#### Scenario: Dragging over a web pane

- **WHEN** a sash drag passes over a web pane's iframe
- **THEN** the sash keeps following the pointer until release

### Requirement: Split right and Split down move the tab into a new pane

The tab context menu's Split right and Split down, and the `splitRight` / `splitDown` keybindings on the focused
pane's active tab, SHALL move the tab into a new pane to the right of or below its pane. When the tab is its pane's
only tab, they SHALL instead create a new terminal in the new pane.

#### Scenario: Split right moves the tab

- **WHEN** pane A holds tabs 1 and 2, tab 2 is active, and the user presses Ctrl+Shift+D
- **THEN** a pane to the right of A holds tab 2 and is focused, and A shows tab 1

#### Scenario: Split on a lone tab opens a terminal

- **WHEN** pane A holds only tab 1 and the user chooses Split down on it
- **THEN** a new pane below A holds a new terminal and is focused, and A still shows tab 1

### Requirement: New tabs open in the focused pane

A tab this window creates (the `+` button, the New-tab page, a file or review opened from the dock, the tmux picker)
SHALL open in the focused pane as its active tab, unless it is created from a specific pane's `+`. A tab that
already exists elsewhere and is opened again (a file or review already open) SHALL be selected in its own pane,
which becomes focused.

#### Scenario: Opening a file

- **WHEN** pane B is focused and the user opens a file from the Explorer
- **THEN** the file's tab opens in pane B as its active tab

#### Scenario: Reopening an open file

- **WHEN** a file is already open in pane A while pane B is focused, and the user opens it again
- **THEN** no new tab is created, pane A is focused and shows that file

### Requirement: Closing a tab activates its neighbour in the same pane

Closing a pane's active tab SHALL activate its left neighbour in that pane's strip, else its right neighbour; other
panes SHALL be unchanged. A tab closed from another window SHALL follow the same rule in this window.

#### Scenario: Close the active tab

- **WHEN** pane A's strip is 1, 3, 4 with 3 active and the user closes 3
- **THEN** pane A shows tab 1 and pane B is unchanged

### Requirement: The layout follows the server's tab list

On every `sessions` broadcast the client SHALL reconcile the layout: a tab that no longer exists, or whose kind
changed (ids are recycled), SHALL leave its pane; a tab no pane holds SHALL join the focused pane without becoming
active. Reconcile SHALL never error and never create a tab. Tab order and colour groups SHALL stay server state; the
layout SHALL hold only which pane holds which tab.

#### Scenario: Another window opens a tab

- **WHEN** another window creates tab 7 while this window has two panes with B focused
- **THEN** tab 7 appears in B's strip and B's active tab does not change

#### Scenario: A recycled id

- **WHEN** a saved layout holds tab 3 as an editor but tab 3 is now a terminal
- **THEN** the editor entry is dropped and terminal 3 joins the focused pane as a new tab

### Requirement: The layout persists per window

The layout tree, each pane's tabs (id and kind) and active tab, the sizes and the focused pane SHALL be saved for the
window only. The focused pane's active tab SHALL stay the window selection of `browser-local-tab-selection`, which
also seeds a window that has no saved layout (a fresh window or a relaunched app opens one pane on that tab).
Unreadable saved layout data SHALL be discarded.

#### Scenario: Reload restores

- **WHEN** a window with three panes is reloaded
- **THEN** the same three panes return with the same tabs, sizes and focused pane

#### Scenario: A fresh window opens one pane

- **WHEN** a window with three panes is open and the user opens a second palmux window
- **THEN** the second window shows one pane on the device's last selected tab, and the first window keeps its panes

#### Scenario: Two windows keep their own layouts

- **WHEN** window 1 has two panes and window 2 has one, and window 2 is reloaded
- **THEN** window 2 still has one pane and window 1 is unchanged

### Requirement: Nothing mounts before the layout is reconciled

On boot the client SHALL NOT mount any pane until the saved layout has been reconciled against the first `sessions`
broadcast, so no pane attaches to a tab that has closed and no terminal is spawned for it.

#### Scenario: A saved terminal that is gone

- **WHEN** the saved layout has a pane holding only terminal 5 and terminal 5 was closed before the reload
- **THEN** that pane is removed during reconcile and no `/ws` attach is made for tab 5

### Requirement: Rearranging panes never remounts a terminal or reparents a pane

Adding, removing, resizing or moving panes and switching a pane's active tab SHALL NOT remount a terminal that stays
on screen in the same pane, and SHALL NOT move any pane's DOM node to a new parent. Each terminal pane SHALL be
keyed by its pane, never by its tab.

#### Scenario: Switching tabs inside a pane

- **WHEN** pane A switches between three terminal tabs
- **THEN** pane A's terminal component mounts once and swaps its session in place

#### Scenario: Splitting next to an iframe

- **WHEN** a web tab is shown in pane A and another tab is dropped on A's right edge
- **THEN** the web tab's iframe is not reloaded
