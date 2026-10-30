# Spec Delta

## MODIFIED Requirements

### Requirement: Tab strip overflows horizontally

When tabs exceed a pane strip's width the strip SHALL keep every pill at or above its minimum width
and scroll horizontally; the strip's `+` button SHALL remain reachable.

#### Scenario: Many tabs

- **WHEN** 12 tabs are open in a narrow window
- **THEN** no pill renders below its minimum width, the strip scrolls horizontally, and the active
  pill is scrolled into view on switch
- **AND** the `+` button stays reachable at the end of the strip, outside the scrolling part

## REMOVED Requirements

### Requirement: The topbar ends with an app menu button

**Reason**: The tab strip moves into each pane (`editor-groups`), so outside window-controls-overlay mode no topbar remains to hold the menu.

**Migration**: "The app menu button tops the dock rail".

## ADDED Requirements

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
