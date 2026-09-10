# browser-local-tab-selection Specification

## Purpose

The application lives at one address, `/`, and which tab a window shows is per-window browser state rather than a URL path — so two windows hold two different tabs, the tab list stays server-shared, and the browser history stack belongs to framed web panes alone.

## Requirements

### Requirement: The application has one canonical address

The client SHALL be served at `/` and SHALL remain there for the lifetime of the
window. Switching tabs, focusing a split slot, closing a tab and opening a file
SHALL NOT change `location.pathname` and SHALL NOT create a browser history
entry.

#### Scenario: Switching tabs leaves the address alone

- **WHEN** the user switches from a terminal tab to a file tab and back
- **THEN** `location.pathname` is `/` throughout and `history.length` is unchanged

#### Scenario: Back belongs to the framed page

- **WHEN** a web tab is focused, the user navigates twice inside the iframe, then
  presses the pane's ← twice
- **THEN** both presses move the framed page back, and no tab switch occurs

### Requirement: Tab selection is per browser window

Which tab a window is showing SHALL be stored in `sessionStorage`, so it is
scoped to one browsing context and survives a reload of that context. It MUST
NOT be stored in `localStorage` and MUST NOT be sent to the server.

#### Scenario: Two windows hold independent selections

- **WHEN** the user opens palmux in two browser tabs and selects a different
  palmux tab in each
- **THEN** each window keeps its own selection, and switching in one does not
  move the other

#### Scenario: A reload keeps the selection

- **WHEN** the user reloads a window showing tab `4`
- **THEN** the window comes back showing tab `4`

#### Scenario: A new window starts clean

- **WHEN** the user opens palmux in a fresh browser tab
- **THEN** it does not inherit any other window's selection

### Requirement: The tab list stays shared, only selection is local

The set of tabs, their order, names, colours and group membership SHALL remain
server state broadcast to every connected client. Creating, closing, renaming or
reordering a tab in one window SHALL be reflected in every window. Only the
window that performed a creation SHALL switch to the new tab.

#### Scenario: A new tab appears everywhere but steals focus nowhere else

- **WHEN** the user creates a tab in window A while window B is showing tab `1`
- **THEN** the new tab appears in both strips, window A switches to it, and
  window B is still showing tab `1`

### Requirement: A missing or dead selection resolves deterministically

The client SHALL resolve an unusable selection without asking, and the rule
depends on WHEN the tab went away. A tab closed while a window was viewing it
SHALL move that window to the neighbour a close uses — the left neighbour in
strip order, else the right — because only the broadcast that carried the close
knows the previous strip order. At BOOT there is no previous order, so a stored
selection naming a tab that no longer exists, or naming an id that has been
recycled into a tab of a DIFFERENT kind, SHALL be treated as absent. No stored
selection SHALL select the FIRST tab in strip order — not the lowest id, because
display order is decoupled from id. No tabs at all SHALL render the New-tab
chooser page.

#### Scenario: The viewed tab is closed from another window

- **WHEN** window B is showing tab `3` and window A closes tab `3`
- **THEN** window B moves to tab `3`'s left neighbour without a reload

#### Scenario: First run in a window

- **WHEN** a window with no stored selection loads and the strip order is
  `['5', '0', '2']`
- **THEN** it shows tab `5`

#### Scenario: A recycled id is not a match

- **WHEN** a window stored tab `2` as a terminal and `2` now exists as an editor
- **THEN** the stored selection is discarded and the first tab in strip order is
  shown

#### Scenario: Storage is unavailable

- **WHEN** `sessionStorage` throws on read or write (private mode, storage
  disabled)
- **THEN** the client still loads, selecting the first tab in strip order, and
  never surfaces an error

### Requirement: Legacy and intent entry points are honoured once

`/<id>` SHALL remain a valid entry: the client reads the id once at boot,
selects that tab, and normalises the address to `/` without adding a history
entry. `GET /new` SHALL redirect to `/?new=1`; the client SHALL create one
terminal for that intent and clear the query.

#### Scenario: An old bookmark still works

- **WHEN** the user opens `/3`
- **THEN** tab `3` is shown and the address becomes `/`

#### Scenario: A script asks for a terminal

- **WHEN** a script opens `http://host/new`
- **THEN** the browser lands on `/`, exactly one new terminal tab is created and
  focused, and reloading afterwards does not create another
