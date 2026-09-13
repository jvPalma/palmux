# window-pop-out Specification

## Purpose

Any tab can be opened in a chrome-less separate browser window (drag-out or menu). A terminal has ONE active view, so the pop-out TAKES THE SESSION OVER rather than mirroring it, and the window it left offers Take back. An origin-validated return path brings the tab home.

## Requirements

### Requirement: Any tab can be opened in a new window

The tab context menu (desktop), the long-press sheet (mobile), and a pane-header ⧉ action SHALL
offer "Open in new window", opening `/popout/<id>` via `window.open` as a popup. The popped
window is a full client attached to the same tab. For a TERMINAL that attach EVICTS the previous
one — a PTY holds a single attachment and the last attach wins — so the pane left behind freezes on
its last frame and offers Take back. `/popout/<id>` SHALL be a real route served by the server, not
a query flag on a tab path, so the pop-out address does not depend on per-tab paths existing.

#### Scenario: A popped-out terminal takes the session over

- **WHEN** the user pops terminal tab 3 out
- **THEN** the popup owns the shell, and the pane in the main window freezes with
  "Opened somewhere else." and a Take back action that re-claims it

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

### Requirement: Dragging a tab out of the browser window pops it out (desktop)

The client SHALL, when a strip-tab drag ends OUTSIDE the browser window (release coordinates beyond
the viewport and no internal drop target), open that tab as a popup positioned near the release
point. If the popup is blocked despite the gesture, the client SHALL show a toast with an explicit
open action instead of failing silently.

#### Scenario: Drag-release outside spawns a window

- **WHEN** the user drags a tab and releases it outside the browser window
- **THEN** a popup window opens near the release position showing that tab

#### Scenario: Release inside a drop zone does not pop out

- **WHEN** the drag ends on an internal split drop zone
- **THEN** a split forms and no popup opens

### Requirement: Popped-out mode hides the shell chrome and offers a return path

With `?popout=1` the client SHALL hide the tab strip / drawer (single-tab window), hide split and
pop-out affordances, and neither read nor write split persistence (the flag is captured once at
boot — in-app navigation drops the query string). A "return to main" affordance SHALL send
`postMessage({ type: 'palmux-popout-return', tabId }, location.origin)` to `window.opener` — never
`'*'` — and close the popup; the main window's listener SHALL accept the message only when
`event.origin === location.origin` and the shape is valid, switching to the tab (no-op if it no
longer exists). When `window.opener` is null or closed, the affordance SHALL be disabled with a
hint rather than failing silently. Closing the popup by any means SHALL never affect the session —
the PTY/note lives on the server. See `docs/popout-protocol.md`.

#### Scenario: Return to main

- **WHEN** the user clicks "return to main" in a popped-out window
- **THEN** the main window switches to that tab and the popup closes

#### Scenario: Foreign-origin messages are ignored

- **WHEN** a window from another origin posts a `palmux-popout-return` message to the main window
- **THEN** the main window ignores it (no tab switch)

#### Scenario: Opener gone

- **WHEN** the main window was closed and the user clicks "return to main"
- **THEN** the popup shows that the main window is unavailable; nothing crashes

#### Scenario: Closing the popup loses nothing

- **WHEN** the user closes a popped-out terminal window
- **THEN** the shell keeps running and reopening the tab shows it intact

#### Scenario: The popped-out tab is killed elsewhere

- **WHEN** the tab shown in a popout is killed from another window
- **THEN** the popup shows an ended state; it SHALL NOT silently switch itself to a different
  session and SHALL NOT offer a reload path that respawns the deliberately killed terminal

#### Scenario: Popping out the same tab twice focuses the existing window

- **WHEN** the user invokes "Open in new window" for a tab that is already popped out
- **THEN** the existing popup is focused/reused (the `palmux-<id>` window name), not duplicated

### Requirement: The sole attached client drives the PTY size

The server SHALL size a terminal's PTY from its ONE active attachment. Smallest-client-wins is
deliberately gone: sizing to `min(cols, rows)` across several clients meant attaching from a phone
silently shrank the same shell on a desktop, and with take-over there is never more than one live
view to reconcile. `resizeClient` SHALL ignore a client that is not the active one, because an
evicted socket can still have a resize in flight and honouring it would reshape the grid under the
client that just took over.

#### Scenario: A pop-out resizes the shell to its own window

- **WHEN** a terminal is taken over by a smaller popped-out window
- **THEN** the PTY is sized to that window's grid, not to the larger window it left

#### Scenario: An evicted client's late resize is ignored

- **WHEN** a resize arrives from a socket that has already been evicted
- **THEN** the PTY keeps the active client's grid

### Requirement: Popping out a tab in a split keeps the split

Popping out a tab that occupies a split slot SHALL NOT collapse the main window's split — the main
window keeps the slot, showing the taken-over state for a terminal. "Return to main" SHALL apply the
strip-selection rule (Rule R) to decide the target slot.

#### Scenario: Pop out a split slot's tab

- **WHEN** the user pops out the tab shown in one slot of a split
- **THEN** the main window still shows the split with that slot, and that slot shows the
  taken-over state with Take back

### Requirement: Only the OS-focused window answers terminal queries

Each window's pane SHALL keep the per-document `hasFocus()` report gate, so a DA/DSR query emitted
by a shell is answered by exactly one window even while several windows hold panes.

#### Scenario: No duplicate answers across windows

- **WHEN** a shell emits a Device Attributes query while panes are open in more than one window
- **THEN** only the window that has OS focus forwards the answer; no "?1;2c" junk appears

### Requirement: No fake drag-back-in

The client SHALL NOT attempt to emulate dragging content from a popped-out window back into the
main window (the web cannot drag across OS windows); the return affordance is the supported path.

#### Scenario: The return path is explicit

- **WHEN** the user wants a popped-out tab back in the main window
- **THEN** the documented mechanism is the "return to main" button (or closing the popup and
  clicking the tab), not a drag gesture
