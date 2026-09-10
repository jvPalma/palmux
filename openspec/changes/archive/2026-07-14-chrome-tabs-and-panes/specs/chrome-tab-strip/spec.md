# chrome-tab-strip

Chrome-visual tab strip on desktop and matching tab rendering in the mobile session drawer.

## ADDED Requirements

### Requirement: Desktop tabs render in Chrome's visual language

The desktop topbar tab strip SHALL render each tab as a rounded-top tab shape visually joined to
the content edge (active tab elevated/continuous with the pane below, inactive tabs recessed),
showing: a kind icon (terminal / web / dashboard / editor) in the favicon slot, the display
title (custom name > OSC title > kind default), and a ✕ close affordance on the active tab and
on hover. A `+` button SHALL sit after the last tab.

#### Scenario: Active tab is visually continuous with the pane

- **WHEN** a tab is active
- **THEN** it renders elevated with no separating border against the content area, while
  inactive tabs render recessed with a divider between neighbors

#### Scenario: Kind icon shown

- **WHEN** a `web` tab and a `terminal` tab are open
- **THEN** each tab shows its kind's icon in the leading (favicon) position

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

When tabs exceed the available width the strip SHALL shrink tabs down to a minimum width and
then scroll horizontally; the `+` button and the topbar action icons SHALL remain reachable.

#### Scenario: Many tabs

- **WHEN** 12 tabs are open in a narrow window
- **THEN** tabs shrink to a minimum width, the strip scrolls horizontally, and the active tab is
  scrolled into view on switch

### Requirement: Mobile drawer rows show the same identity

Mobile drawer session rows SHALL display each tab's kind icon, display title, and color
indicator (dot or edge accent) consistent with the desktop strip, sourced from the same
`sessions.tabs` metadata.

#### Scenario: Rename on desktop appears on phone

- **WHEN** a tab is renamed from a desktop client
- **THEN** the mobile drawer row shows the new name after the next `sessions` broadcast without
  a reload
