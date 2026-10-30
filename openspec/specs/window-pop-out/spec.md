# window-pop-out Specification

## Purpose

Any tab can be opened in a chrome-less separate browser window (drag-out or menu). A terminal has ONE active view, so the pop-out TAKES THE SESSION OVER rather than mirroring it, and the window it left offers Take back. An origin-validated return path brings the tab home.

## Requirements

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

### Requirement: Only the OS-focused window answers terminal queries

Each window's pane SHALL keep the per-document `hasFocus()` report gate, so a DA/DSR query emitted
by a shell is answered by exactly one window even while several windows hold panes.

#### Scenario: No duplicate answers across windows

- **WHEN** a shell emits a Device Attributes query while panes are open in more than one window
- **THEN** only the window that has OS focus forwards the answer; no "?1;2c" junk appears
