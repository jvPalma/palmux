# Spec Delta

## ADDED Requirements

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

### Requirement: The topbar ends with an app menu button

The topbar SHALL end with an icon button as its LAST control, after the tab strip and the `+` button,
outside the scrolling strip and, except in window-controls-overlay mode, aligned over the dock rail
column. It SHALL open an app menu offering at least Settings, Tips and Reload app, end-aligned so the
menu opens inside the window. The `palmux` text wordmark SHALL NOT appear in the topbar.

#### Scenario: The menu is the last control

- **WHEN** the desktop topbar renders
- **THEN** the app menu button is its last control, after the tab strip and `+`, and the tab strip
  starts at the bar's left edge

#### Scenario: The button sits over the rail

- **WHEN** the dock rail is shown
- **THEN** the app menu button shares the centre line of the rail's own buttons

#### Scenario: Window-controls-overlay keeps the menu in the title bar

- **WHEN** the installed app runs in window-controls-overlay mode, where the topbar fills only the
  title-bar area
- **THEN** the app menu button is the last control of the title-bar area, beside the native window
  controls, and is not required to align over the rail

#### Scenario: The menu opens inside the window

- **WHEN** the user activates the app menu button at the window's right edge
- **THEN** the menu opens with its right edge on the button's right edge and stays fully on screen

#### Scenario: A second route to Settings

- **WHEN** the user chooses Settings from the app menu while the rail is shown
- **THEN** the Settings view opens in the dock, the view the rail's Settings button and Ctrl+, also
  open

## MODIFIED Requirements

### Requirement: Tab strip overflows horizontally

When tabs exceed the available width the strip SHALL keep every pill at or above its minimum width
(fused split pills at their own minimum) and scroll horizontally; the `+` button and the app menu
button SHALL remain reachable.

#### Scenario: Many tabs

- **WHEN** 12 tabs are open in a narrow window
- **THEN** no pill renders below its minimum width, the strip scrolls horizontally, and the active
  pill is scrolled into view on switch
- **AND** the `+` button and the app menu button stay reachable, the menu button remaining at the end
  of the bar outside the scrolling strip

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

## REMOVED Requirements

### Requirement: Desktop tabs render in Chrome's visual language

**Reason**: The owner chose the pill model (D1-B, 2026-10-24) because the Chrome tab shape could not
distinguish active, split and grouped tabs. The taller active tab, the top-only radius and the 8%
tints are what the review measured as indistinguishable.

**Migration**: Replaced by "Desktop tabs render as pills" and "The active pill clears a contrast
floor". Group and split rendering moves to `tab-grouping` and `split-fusion`.
