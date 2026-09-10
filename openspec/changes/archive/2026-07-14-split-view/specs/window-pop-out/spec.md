# window-pop-out

Open a tab as a separate browser window on the same session, with a desktop tear-off
approximation and an explicit return path. Built on the existing URL-is-the-session model:
multiple windows attached to one PTY already mirror each other.

## ADDED Requirements

### Requirement: Any tab can be opened in a new window

The tab context menu (desktop), the long-press sheet (mobile), and a pane-header ⧉ action SHALL
offer "Open in new window", opening `/<id>?popout=1` via `window.open` as a popup. The popped
window is a full client attached to the same tab — for a terminal, both windows mirror the same
shell live.

#### Scenario: Terminal mirrors across windows

- **WHEN** the user pops terminal tab 3 out and types in the new window
- **THEN** the same output appears in both windows (one PTY, two attached clients)

#### Scenario: Works for panes too

- **WHEN** the user pops an editor tab out
- **THEN** the popup shows that editor bound to the same server-side note

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

### Requirement: Mirrored windows resize the PTY smallest-client-wins

The server SHALL size a multi-attach PTY to `min(cols)` × `min(rows)` across all live attaches
(NOT last-writer-wins) — tracking each client's last-reported size and recomputing on attach,
detach, and every client resize — so the pop-out mirror (or the same session opened twice) stays
readable in every window. This keeps both windows readable (the larger letterboxes to the
smaller), matching tmux multi-attach behavior.

#### Scenario: Two differently-sized windows stay readable

- **WHEN** a terminal is open in a large main window and a smaller popup attaches to the same
  session
- **THEN** the PTY is sized to the smaller window's grid and both windows render the shell without
  wrapped garbage

#### Scenario: Closing the smaller window relaxes the size

- **WHEN** the smaller of two mirrored windows closes
- **THEN** the PTY resizes up to the remaining window's grid

### Requirement: Popping out a tab in a split keeps the split (stay + mirror)

Popping out a tab that occupies a split slot SHALL NOT collapse the main window's split — the main
window keeps the slot and the popup mirrors the same session (subject to the resize policy above).
"Return to main" SHALL apply the strip-selection rule (Rule R) to decide the target slot.

#### Scenario: Pop out a split slot's tab

- **WHEN** the user pops out the tab shown in one slot of a split
- **THEN** the main window still shows the split with that slot, and the popup mirrors it

### Requirement: Only the OS-focused window answers terminal queries

With one session mirrored across the main window and a popout, each window's pane SHALL keep the
per-document `hasFocus()` report gate, so a DA/DSR query emitted by the shell is answered by
exactly one window.

#### Scenario: No duplicate answers across windows

- **WHEN** a terminal is mirrored in a popped-out window and its shell emits a Device Attributes
  query
- **THEN** only the window that has OS focus forwards the answer; no "?1;2c" junk appears

### Requirement: No fake drag-back-in

The client SHALL NOT attempt to emulate dragging content from a popped-out window back into the
main window (the web cannot drag across OS windows); the return affordance is the supported path.

#### Scenario: The return path is explicit

- **WHEN** the user wants a popped-out tab back in the main window
- **THEN** the documented mechanism is the "return to main" button (or closing the popup and
  clicking the tab), not a drag gesture
