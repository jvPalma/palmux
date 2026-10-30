# chrome-tab-strip Specification

## Purpose

The desktop tab strip renders in Chrome's visual language, closes only via a confirming ✕, overflows horizontally, and shows the same tab identity in the mobile drawer.

## Requirements

### Requirement: Closing a tab requires targeting the ✕ and confirms terminals

Clicking a tab's body SHALL switch to it (including the active tab — the current
"tap-active-to-kill" behavior is removed). Clicking the ✕ SHALL close the tab; for `terminal`
tabs a confirmation SHALL be required (shell termination warning), for non-terminal kinds with
no unsaved state it SHALL close immediately.

#### Scenario: Clicking the active tab is a no-op

- **WHEN** the user clicks the body of the already-active tab
- **THEN** nothing is killed and no confirmation appears

#### Scenario: Terminal close confirms

- **WHEN** the user clicks ✕ on a terminal tab
- **THEN** a confirmation is shown before `kill` is sent

### Requirement: Tab strip overflows horizontally

When tabs exceed a pane strip's width the strip SHALL keep every pill at or above its minimum width
and scroll horizontally; the strip's `+` button SHALL remain reachable.

#### Scenario: Many tabs

- **WHEN** 12 tabs are open in a narrow window
- **THEN** no pill renders below its minimum width, the strip scrolls horizontally, and the active
  pill is scrolled into view on switch
- **AND** the `+` button stays reachable at the end of the strip, outside the scrolling part

### Requirement: Mobile drawer rows show the same identity

Mobile drawer session rows SHALL display each tab's display title and colour consistently with the
desktop strip, sourced from the same `sessions.tabs` metadata. The colour SHALL appear as the same
identity dot the strip uses; how a row marks the active tab is defined by `mobile-drawer`.

#### Scenario: Rename on desktop appears on phone

- **WHEN** a tab is renamed from a desktop client
- **THEN** the mobile drawer row shows the new name after the next `sessions` broadcast without
  a reload

#### Scenario: Active drawer row matches desktop treatment

- **WHEN** the drawer opens while a coloured tab is active
- **THEN** that row is marked active without a colour fill (the treatment `mobile-drawer` defines),
  matching the desktop rule that colour never marks the active tab

#### Scenario: Colour appears as the same dot

- **WHEN** a tab is coloured orange from the desktop
- **THEN** its strip pill and its drawer row both show an orange dot, and neither is filled orange

### Requirement: Desktop tabs render as pills

Each desktop tab SHALL render as a rounded pill with a subtle 1px border, separated from its
neighbours by a gap. It shows a colour dot when coloured, a kind icon for non-terminal kinds only,
the display title, and a ✕ on the active pill and on hover. Pills SHALL grow with their title up to a
maximum width and share space down to a minimum before the strip scrolls. A `+` button SHALL follow
the last pill.

#### Scenario: Terminal pill has no kind icon

- **WHEN** a terminal tab and a markdown tab are open
- **THEN** only the markdown pill shows a kind icon, and both pills carry the same subtle border

#### Scenario: Space is used before truncating

- **WHEN** five tabs fit comfortably in the strip
- **THEN** each pill shows its full title up to the maximum width instead of truncating at a fixed
  width

### Requirement: The active pill clears a contrast floor

The active pill SHALL be distinguished by a raised fill plus a ring, and its fill SHALL differ from
the strip background by at least the theme's surface step. Its title SHALL use full-strength text and
a heavier weight. Colour SHALL NOT be what marks the active pill.

#### Scenario: Active is the loudest pill

- **WHEN** an uncoloured tab is active next to inactive tabs coloured red and yellow
- **THEN** the uncoloured active pill is the only raised, ringed pill, and the coloured inactive
  pills differ from the others only by their dots

### Requirement: The app menu button tops the dock rail

On a desktop the app menu button SHALL be the first control of the dock rail, above New tab, in every display mode,
and SHALL open the app menu (at least Settings, Tips and Reload app) inside the window. There SHALL be no topbar;
in window-controls-overlay mode the title-bar area is an empty drag region. The `palmux` wordmark SHALL NOT appear.

#### Scenario: The menu tops the rail

- **WHEN** the desktop app renders in a browser tab
- **THEN** no topbar is drawn, the first rail button opens the app menu, and the panes start at the top edge

#### Scenario: Window-controls-overlay keeps a title bar

- **WHEN** the installed app runs in window-controls-overlay mode
- **THEN** the title-bar area is an empty drag region and the app menu button is still the rail's first control

#### Scenario: A second route to Settings

- **WHEN** the user chooses Settings from the app menu
- **THEN** the Settings view opens in the dock, the view the rail's Settings button and Ctrl+, also open
