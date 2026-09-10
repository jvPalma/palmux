## MODIFIED Requirements

### Requirement: Any tab can be opened in a new window

The tab context menu (desktop), the long-press sheet (mobile), and a pane-header ⧉ action SHALL
offer "Open in new window", opening `/popout/<id>` via `window.open` as a popup. The popped
window is a full client attached to the same tab — for a terminal, both windows mirror the same
shell live. `/popout/<id>` SHALL be a real route served by the server, not a query flag on a tab
path, so the pop-out address does not depend on per-tab paths existing.

#### Scenario: Terminal mirrors across windows

- **WHEN** the user pops terminal tab 3 out and types in the new window
- **THEN** the same output appears in both windows (one PTY, two attached clients)

#### Scenario: Works for panes too

- **WHEN** the user pops an editor tab out
- **THEN** the popup shows that editor bound to the same server-side note

#### Scenario: A pop-out survives a reload

- **WHEN** the user hard-reloads a popped-out window at `/popout/3`
- **THEN** it comes back attached to tab 3, still chrome-less, and does not fall
  back to the full app

#### Scenario: The legacy pop-out address still resolves

- **WHEN** a window is opened at `/3?popout=1`
- **THEN** it shows tab 3 as a pop-out, and the address normalises to `/popout/3`
