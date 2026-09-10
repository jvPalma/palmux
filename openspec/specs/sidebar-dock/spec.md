# sidebar-dock Specification

## Purpose

Settings, the new-tab chooser, Files and Dictation are views of one right-side dock that takes layout width instead of covering the terminal, with a per-device icon rail and a resize discipline that costs each attached shell one SIGWINCH per toggle.

## Requirements

### Requirement: App surfaces render in a side dock instead of modals

palmux SHALL host Settings, the new-tab chooser, Files and Dictation as **views of one right-side
dock** rather than as modal overlays. The dock SHALL occupy layout width, shrinking the content area,
and MUST NOT cover the terminal — the terminal is what the user is reading from while using these
surfaces. Exactly one view SHALL be active at a time, and the active view SHALL persist per device.

#### Scenario: Opening settings keeps the terminal readable

- **WHEN** the user opens Settings while a terminal is showing output
- **THEN** the dock appears beside the terminal, the terminal narrows, and no terminal content is
  hidden behind an overlay

#### Scenario: Switching views does not close the dock

- **WHEN** the dock is showing Settings and the user selects Files
- **THEN** the dock stays open and swaps its content

### Requirement: The icon rail is a per-device preference

The dock SHALL offer a persistent icon rail listing its views. Its visibility SHALL be controlled by a
`sidebarRail` preference with values `always` and `hidden`, defaulting to `always` on desktop and
`hidden` on mobile. `sidebarRail` SHALL be stored **per device** and MUST NOT be added to the synced
settings keys, because a synced copy reintroduces the cross-machine conflict that per-device
persistence exists to prevent.

#### Scenario: Rail hidden still reaches every view

- **WHEN** `sidebarRail` is `hidden`
- **THEN** no rail is rendered, and every view remains reachable from its keyboard shortcut
  (`settings` is Ctrl+,) and from the command palette
- **AND** the `sidebarRail` row SHALL state that hiding the rail leaves the keybinding as the only
  route, because the desktop topbar no longer carries a settings control

#### Scenario: The preference does not travel between machines

- **WHEN** the user sets `sidebarRail` to `hidden` on one device and the synced settings are read on
  another
- **THEN** the second device keeps its own value

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
