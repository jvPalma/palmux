# Spec Delta

## MODIFIED Requirements

### Requirement: The sole attached client drives the PTY size

The server SHALL size a terminal's PTY from its ONE active attachment. Smallest-client-wins is
deliberately gone: sizing to `min(cols, rows)` across several clients meant attaching from a phone
silently shrank the same shell on a desktop, and with take-over there is never more than one live
view to reconcile. `resizeClient` SHALL ignore a client that is not the active one, because an
evicted socket can still have a resize in flight and honouring it would reshape the grid under the
client that just took over.

#### Scenario: A pop-out resizes the shell to its own window

- **WHEN** a terminal shown on a desktop is attached from a smaller window, such as a phone or a detached
  window it was moved into
- **THEN** the PTY is sized to that window's grid, not to the larger window it left

#### Scenario: An evicted client's late resize is ignored

- **WHEN** a resize arrives from a socket that has already been evicted
- **THEN** the PTY keeps the active client's grid

## REMOVED Requirements

### Requirement: Any tab can be opened in a new window

**Reason**: The pop-out mirrored the tab and took a terminal over, leaving "Opened somewhere else." behind.
"Open in new window" now MOVES the tab into a detached window.

**Migration**: "Open in new window moves the tab into a detached window" (`detached-windows`). `/popout/<id>`
and `/<id>?popout=1` still resolve, as detached windows.

### Requirement: Dragging a tab out of the browser window pops it out (desktop)

**Reason**: It was specified and never built: no drag-end handler compares the release point with the
viewport (recon, 2026-10-27). Moving tabs between windows is now a real drop on another palmux window.

**Migration**: Use "Open in new window" in the tab menu, then drag tabs between the windows (`detached-windows`).

### Requirement: Popped-out mode hides the shell chrome and offers a return path

**Reason**: The single-tab window and its "return to main" bar are replaced by the full detached window.

**Migration**: "A detached window is an editor-groups window without the dock", and the "Move to main
window" menu item (`detached-windows`).

### Requirement: Popping out a tab in a pane keeps the pane

**Reason**: The tab now leaves the main window instead of staying behind in the taken-over state.

**Migration**: "A tab is shown by exactly one window" (`detached-windows`). The main window's pane re-picks its
active tab by the close rule.

### Requirement: No fake drag-back-in

**Reason**: Windows of the same browser can drag to each other, because `DataTransfer` types are visible
across them. Moving a tab between palmux windows is a supported drop.

**Migration**: "Tabs move between windows by drag and drop" (`detached-windows`).
