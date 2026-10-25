# Spec Delta

## Purpose

An installed PWA's window is a browsing context the OS ends whenever it likes, so a selection held in
`sessionStorage` alone is lost on every relaunch. This delta adds a device-wide fallback that a window
reads only when it has no selection of its own.

## MODIFIED Requirements

### Requirement: Tab selection is per browser window

Which tab a window is showing SHALL be stored in `sessionStorage`, so it is scoped to one browsing
context and survives a reload of that context, and it MUST NOT be sent to the server. The client
SHALL also keep the device's most recently SELECTED tab in `localStorage`, written only when a
window's selection actually changes (never on a tab-list or title broadcast) and never by a pop-out.
A window SHALL read that device-wide value only when it has no `sessionStorage` selection of its own;
a window's own selection always wins, so an open window is never moved by another.

#### Scenario: Two windows hold independent selections

- **WHEN** the user opens palmux in two browser tabs and selects a different palmux tab in each
- **THEN** each window keeps its own selection, and switching in one does not move the other

#### Scenario: A reload keeps the selection

- **WHEN** the user reloads a window showing tab `4`
- **THEN** the window comes back showing tab `4`

#### Scenario: A new window starts clean

- **WHEN** the user opens palmux in a fresh browser tab on a device where no tab has been selected
  yet (or the stored value is unusable)
- **THEN** it starts on the first tab in strip order, and inherits no other window's selection

#### Scenario: A relaunched PWA comes back on its last tab

- **WHEN** the installed app is showing tab `2`, is closed, and is opened again
- **THEN** it shows tab `2`

#### Scenario: A new window starts on the device's last selection

- **WHEN** the user opens palmux in a fresh browser tab after last selecting tab `2` in another window
- **THEN** the fresh window starts on tab `2`, and the other window is not moved

#### Scenario: A broadcast does not rewrite the last selection

- **WHEN** window B last selected tab `2`, and window A (showing tab `1`) then receives a tab-title
  broadcast
- **THEN** the device-wide last selection is still tab `2`
