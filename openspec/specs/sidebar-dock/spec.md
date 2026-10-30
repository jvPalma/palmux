# sidebar-dock Specification

## Purpose

Settings, the new-tab chooser, Files and Dictation are views of one right-side dock that takes layout width instead of covering the terminal, with a per-device icon rail and a resize discipline that costs each attached shell one SIGWINCH per toggle.

## Requirements

### Requirement: App surfaces render in a side dock instead of modals

palmux SHALL host Settings, the new-tab chooser, Files, Source Control and Dictation as **views of one
right-side dock** rather than as modal overlays. The dock SHALL occupy layout width, shrinking the content
area, and MUST NOT cover the terminal — the terminal is what the user is reading from while using these
surfaces. Exactly one view SHALL be active at a time, and the active view SHALL persist per device.

#### Scenario: Opening settings keeps the terminal readable

- **WHEN** the user opens Settings while a terminal is showing output
- **THEN** the dock appears beside the terminal, the terminal narrows, and no terminal content is
  hidden behind an overlay

#### Scenario: Switching views does not close the dock

- **WHEN** the dock is showing Settings and the user selects Files
- **THEN** the dock stays open and swaps its content

#### Scenario: Source Control is a dock view

- **WHEN** the user selects Source Control on the rail
- **THEN** the dock shows the Source Control view beside the content area, and a review it opens goes to
  the content area, not the dock

### Requirement: Toggling the dock must not storm attached shells

The refit caused by opening, closing or resizing the dock SHALL be deferred and coalesced using the
same discipline the split divider already applies during a drag, so that a single dock toggle produces
at most one resize per attached PTY rather than one per animation frame. Every visible terminal
changes width when the dock moves, and an un-coalesced resize storm makes a settings click redraw
every attached tmux.

#### Scenario: Opening the dock resizes each shell once

- **WHEN** the dock opens while two split terminals are attached
- **THEN** each PTY receives at most one resize for the transition, and neither shell redraws
  repeatedly during the animation

#### Scenario: Dragging the dock edge

- **WHEN** the user drags the dock's edge to resize it
- **THEN** the panes refit visually during the drag but the PTY resize is issued on settle

### Requirement: A view can be promoted to a full pane

A dock view whose content benefits from width — Files and configuration editing at minimum — SHALL
offer a control that promotes it to a full tab/pane, leaving the dock free for another view.

#### Scenario: Promoting the file view

- **WHEN** the user promotes the Files view
- **THEN** the file opens as a pane occupying the content area and the dock returns to its previous
  view or closes

### Requirement: The rail orders entries by frequency of use

The desktop rail SHALL list, from top to bottom: the app menu button, New tab, Explorer, Source Control, Dictation, a
separator, Upload, Download, and Settings pinned to the bottom of the rail.

#### Scenario: Settings sits at the bottom

- **WHEN** the rail is visible on desktop
- **THEN** the app menu button is the topmost control, New tab the topmost view entry below it, and Settings is the
  bottommost, separated from the other entries by free space

#### Scenario: Source Control follows Explorer

- **WHEN** the rail is visible on desktop
- **THEN** Source Control is the entry directly below Explorer and directly above Dictation

### Requirement: The desktop rail is always shown

The dock's icon rail SHALL be rendered whenever the desktop layout is, and no setting SHALL hide it.
A `sidebarRail` value stored by an earlier version SHALL be parsed and ignored. `sidebarRail` MUST NOT
be added to the synced settings keys, because a synced copy would put a per-machine value back into
the tracked settings file.

#### Scenario: A stored hidden value does not remove the rail

- **WHEN** the stored settings carry `sidebarRail: 'hidden'` and the desktop layout is active
- **THEN** the rail is rendered with every entry, and Explorer, Dictation, Upload and Download are
  reachable by pointer

#### Scenario: Settings offers no rail option

- **WHEN** the user opens Settings › App on desktop or in the mobile drawer
- **THEN** no Sidebar rail row is shown

#### Scenario: The retired value does not travel between machines

- **WHEN** a device stores a `sidebarRail` value and the synced settings payload is built
- **THEN** the payload does not contain `sidebarRail`

#### Scenario: Mobile has no rail

- **WHEN** the mobile layer is active
- **THEN** no rail is rendered, and the drawer hosts the same surfaces
